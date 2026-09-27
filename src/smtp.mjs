import smtpServerPackage from 'smtp-server';
import { simpleParser } from 'mailparser';
import { htmlToText } from 'html-to-text';
import { ingestMessage, now, MAX_MESSAGE_CHARS } from './db.mjs';
import { normalizeEmail } from './domain.mjs';

const { SMTPServer } = smtpServerPackage;
const MAX_SMTP_BYTES = 1_048_576;

export function createSmtpServer(db, config) {
  const recipientRow = address => {
    let recipient;
    try { recipient = normalizeEmail(address); } catch { return null; }
    const alias = db.prepare(`SELECT a.user_id,a.mailbox_id,a.address FROM aliases a
      JOIN mailboxes b ON b.id=a.mailbox_id
      WHERE a.address=? AND a.status='active' AND (a.expires_at IS NULL OR a.expires_at>?)
      AND b.status='connected' AND ((b.provider='domain' AND b.address=?) OR b.credential_cipher IS NOT NULL) LIMIT 1`).get(recipient,now(),`*@${config.ownedDomain}`);
    if (alias) return {userId:alias.user_id,mailboxId:alias.mailbox_id,address:alias.address};
    const box = db.prepare(`SELECT user_id,id,address FROM mailboxes
      WHERE address=? AND credential_cipher IS NOT NULL LIMIT 1`).get(recipient);
    return box ? {userId:box.user_id,mailboxId:box.id,address:box.address} : null;
  };

  return new SMTPServer({
    name: 'localhost',
    banner: 'Mail Neon local inbound',
    secure: false,
    authOptional: true,
    disabledCommands: ['AUTH','STARTTLS'],
    size: MAX_SMTP_BYTES,
    maxClients: 10,
    socketTimeout: 30_000,
    onRcptTo(address, session, callback) {
      if (recipientRow(address.address)) return callback();
      const error = new Error('Unknown recipient');
      error.responseCode = 550;
      callback(error);
    },
    onData(stream, session, callback) {
      (async()=>{
        const chunks=[]; let size=0;
        for await (const chunk of stream) {
          size += chunk.length;
          if (size > MAX_SMTP_BYTES || stream.sizeExceeded) {
            if (typeof stream.destroy === 'function') stream.destroy();
            const error=new Error('Message too large'); error.responseCode=552; throw error;
          }
          chunks.push(chunk);
        }
        const parsed=await simpleParser(Buffer.concat(chunks));
        const sender=parsed.from?.value?.[0]?.address || session.envelope.mailFrom?.address || '';
        const text=String(parsed.text || (parsed.html ? htmlToText(String(parsed.html)) : '')).slice(0,MAX_MESSAGE_CHARS);
        const messageId=String(parsed.messageId || session.id).slice(0,250);
        let accepted=0;
        for (const item of session.envelope.rcptTo) {
          const recipient=recipientRow(item.address);
          if (!recipient) continue;
          ingestMessage(db,config.key,{
            userId:recipient.userId,mailboxId:recipient.mailboxId,
            providerMessageId:messageId,sender,recipients:[recipient.address],
            subject:String(parsed.subject || '').slice(0,500),text,receivedAt:now()
          });
          accepted++;
        }
        if (!accepted) {
          const error=new Error('No active recipient'); error.responseCode=550; throw error;
        }
        callback(null,'Message accepted');
      })().catch(callback);
    }
  });
}

