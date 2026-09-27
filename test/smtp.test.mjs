import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import { createInterface } from 'node:readline';
import { openDatabase, messageForUser, now } from '../src/db.mjs';
import { createSmtpServer } from '../src/smtp.mjs';

test('local SMTP rejects unknown recipients and stores mail for an active owned-domain alias',async()=>{
  const db=openDatabase(':memory:');
  const key=randomBytes(32);
  const stamp=now();
  db.prepare('INSERT INTO users(id,email,password_hash,created_at) VALUES(?,?,?,?)').run('owner','owner@example.test','hash',stamp);
  db.prepare("INSERT INTO mailboxes(id,user_id,provider,address,label,status,created_at) VALUES('domain','owner','domain','*@example.test','Example','connected',?)").run(stamp);
  db.prepare("INSERT INTO aliases(id,user_id,mailbox_id,address,kind,status,created_at) VALUES('alias','owner','domain','otp@example.test','domain','active',?)").run(stamp);
  const smtp=createSmtpServer(db,{key,ownedDomain:'example.test'});
  let socket;
  try {
    await new Promise(resolve=>smtp.listen(0,'127.0.0.1',resolve));
    socket=connect(smtp.server.address().port,'127.0.0.1');
    const lines=createInterface({input:socket})[Symbol.asyncIterator]();
    const readResponse=async()=>{
      const result=[];
      while(true){
        const {value,done}=await lines.next();
        if(done) throw new Error('SMTP connection closed unexpectedly');
        result.push(value);
        if(/^\d{3} /.test(value)) return result.join('\n');
      }
    };
    assert.match(await readResponse(),/^220 /);
    socket.write('EHLO localhost\r\n'); assert.match(await readResponse(),/^250[ -]/);
    socket.write('MAIL FROM:<sender@example.org>\r\n'); assert.match(await readResponse(),/^250 /);
    socket.write('RCPT TO:<missing@example.test>\r\n'); assert.match(await readResponse(),/^550 /);
    socket.write('RCPT TO:<otp@example.test>\r\n'); assert.match(await readResponse(),/^250 /);
    socket.write('DATA\r\n'); assert.match(await readResponse(),/^354 /);
    socket.write('From: sender@example.org\r\nTo: otp@example.test\r\nSubject: Verification\r\nMessage-ID: <smtp-test@example.org>\r\n\r\nYour verification code is 429731\r\n.\r\n');
    assert.match(await readResponse(),/^250 /);
    const row=db.prepare('SELECT id FROM messages WHERE user_id=?').get('owner');
    assert.ok(row);
    assert.match(messageForUser(db,key,'owner',row.id).text,/429731/);
  } finally {
    socket?.destroy();
    await new Promise(resolve=>smtp.close(resolve));
    db.close();
  }
});
