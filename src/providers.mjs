import { createHash, randomUUID } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { convert } from 'html-to-text';
import { decrypt, encrypt, hashToken, randomToken } from './crypto.mjs';
import { audit, ingestMessage, MAX_MESSAGE_CHARS, now } from './db.mjs';

const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const MICROSOFT_SCOPE = 'offline_access User.Read Mail.Read';
const timeout = ms => AbortSignal.timeout(ms);
const MAX_PROVIDER_JSON_BYTES = 8_000_000;
const textFromHtml = html => convert(String(html || '').slice(0,500_000), { wordwrap: false, selectors: [{selector:'img', format:'skip'}, {selector:'a', options:{hideLinkHrefIfSameAsText:true}}] }).slice(0, MAX_MESSAGE_CHARS);

async function providerFetch(url, options = {}, retries = 2) {
  const host = new URL(url).hostname;
  if (!['gmail.googleapis.com','oauth2.googleapis.com','www.googleapis.com','graph.microsoft.com','login.microsoftonline.com','accounts.google.com'].includes(host)) throw new Error('Unexpected provider URL');
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { ...options, redirect:'error', signal: timeout(15_000) });
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      await new Promise(resolve => setTimeout(resolve, 300 * 2 ** attempt + Math.floor(Math.random() * 200)));
      continue;
    }
    if (!res.ok) {
      const error = new Error(`Provider HTTP ${res.status}`);
      error.status = res.status;
      throw error;
    }
    return res;
  }
}
async function providerJson(url, options = {}) {
  const res = await providerFetch(url, options);
  if (!res.body) throw new Error('Provider returned an empty response');
  const chunks=[]; let size=0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > MAX_PROVIDER_JSON_BYTES) throw new Error('Provider response exceeds the size limit');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks,size).toString('utf8'));
}
function oauthConfig(config, provider) {
  const credentials = provider === 'google' ? config.google : provider === 'microsoft' ? config.microsoft : null;
  if (!credentials) throw new Error(`${provider} OAuth is not configured`);
  const redirectUri = `${config.baseUrl}/api/v1/oauth/${provider}/callback`;
  return { ...credentials, redirectUri };
}
function oauthEndpoint(provider, part) {
  return provider === 'google' ? (part === 'authorize' ? 'https://accounts.google.com/o/oauth2/v2/auth' : 'https://oauth2.googleapis.com/token') : `https://login.microsoftonline.com/common/oauth2/v2.0/${part}`;
}
export function startOAuth(db, config, userId, provider) {
  const app = oauthConfig(config, provider);
  const state = randomToken();
  const verifier = randomToken(48);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  db.prepare('INSERT INTO oauth_states(state_hash,user_id,provider,verifier,expires_at) VALUES(?,?,?,?,?)')
    .run(hashToken(state, config.sessionPepper), userId, provider, verifier, new Date(Date.now()+10*60_000).toISOString());
  const url = new URL(oauthEndpoint(provider, 'authorize'));
  url.searchParams.set('client_id', app.id);
  url.searchParams.set('redirect_uri', app.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', provider === 'google' ? GOOGLE_SCOPE : MICROSOFT_SCOPE);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (provider === 'google') { url.searchParams.set('access_type', 'offline'); url.searchParams.set('prompt', 'consent'); }
  return url.toString();
}
export async function finishOAuth(db, config, provider, state, code, userId) {
  const stateHash = hashToken(String(state || ''), config.sessionPepper);
  const row = db.prepare('SELECT * FROM oauth_states WHERE state_hash=? AND provider=?').get(stateHash,provider);
  if (!row || row.expires_at < now() || row.user_id !== userId) throw new Error('OAuth state expired or invalid');
  db.prepare('DELETE FROM oauth_states WHERE state_hash=?').run(stateHash);
  if (!code) throw new Error('Provider did not return an authorization code');
  const app = oauthConfig(config, provider);
  const body = new URLSearchParams({ client_id:app.id, client_secret:app.secret, code:String(code), code_verifier:row.verifier, redirect_uri:app.redirectUri, grant_type:'authorization_code' });
  const tokens = await providerJson(oauthEndpoint(provider,'token'), { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body });
  if (!tokens.access_token) throw new Error('Provider returned no access token');
  const bearer = { Authorization:`Bearer ${tokens.access_token}` };
  const profile = provider === 'google'
    ? await providerJson('https://gmail.googleapis.com/gmail/v1/users/me/profile', {headers:bearer})
    : await providerJson('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName', {headers:bearer});
  const address = String(provider === 'google' ? profile.emailAddress : (profile.mail || profile.userPrincipalName)).toLowerCase();
  if (!address.includes('@')) throw new Error('Provider returned no email address');
  const prior = db.prepare('SELECT * FROM mailboxes WHERE user_id=? AND provider=? AND address=?').get(row.user_id,provider,address);
  const old = prior?.credential_cipher ? JSON.parse(decrypt(prior.credential_cipher,config.key)) : null;
  const credential = encrypt(JSON.stringify({ accessToken:tokens.access_token, refreshToken:tokens.refresh_token || old?.refreshToken || null, expiresAt:Date.now()+(Number(tokens.expires_in || 3600)-60)*1000 }),config.key);
  if (!tokens.refresh_token && !old?.refreshToken) throw new Error('Provider did not grant offline access; reconnect and consent to offline access');
  const id = prior?.id || randomUUID();
  db.prepare(`INSERT INTO mailboxes(id,user_id,provider,address,label,credential_cipher,status,created_at)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(user_id,provider,address) DO UPDATE SET credential_cipher=excluded.credential_cipher,status='connected',last_error=NULL`)
    .run(id,row.user_id,provider,address,address,credential,'connected',now());
  audit(db,row.user_id,'mailbox.connect',id);
  return { id, address };
}
async function activeToken(db, config, mailbox) {
  const credential = JSON.parse(decrypt(mailbox.credential_cipher,config.key));
  if (credential.expiresAt > Date.now()+30_000) return credential.accessToken;
  if (!credential.refreshToken) throw new Error('Reconnect required');
  const app = oauthConfig(config,mailbox.provider);
  const body = new URLSearchParams({ client_id:app.id, client_secret:app.secret, refresh_token:credential.refreshToken, grant_type:'refresh_token' });
  const next = await providerJson(oauthEndpoint(mailbox.provider,'token'),{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body});
  if (!next.access_token) throw new Error('Token refresh failed');
  credential.accessToken = next.access_token;
  credential.refreshToken = next.refresh_token || credential.refreshToken;
  credential.expiresAt = Date.now()+(Number(next.expires_in || 3600)-60)*1000;
  db.prepare('UPDATE mailboxes SET credential_cipher=? WHERE id=?').run(encrypt(JSON.stringify(credential),config.key),mailbox.id);
  return credential.accessToken;
}
function gmailHeaders(payload) {
  const headers = Object.fromEntries((payload.headers || []).map(x => [String(x.name).toLowerCase(),x.value]));
  return headers;
}
function gmailBody(part, wanted, budget={remaining:100}, depth=0) {
  if (!part || depth>16 || budget.remaining--<=0) return null;
  if (part.mimeType === wanted && part.body?.data) return Buffer.from(String(part.body.data).slice(0,1_100_000),'base64url').toString('utf8').slice(0,MAX_MESSAGE_CHARS);
  for (const child of part.parts || []) { const found = gmailBody(child,wanted,budget,depth+1); if (found) return found; }
  return null;
}
function addressesFromHeader(value) { return String(value || '').split(',').map(v => v.match(/<([^>]+)>/)?.[1] || v.trim()).map(v=>v.toLowerCase()).filter(v=>v.includes('@')); }
async function syncGoogle(db, config, mailbox) {
  const token = await activeToken(db,config,mailbox);
  const headers = { Authorization:`Bearer ${token}` };
  const saved = mailbox.cursor ? JSON.parse(mailbox.cursor) : null;
  const since = saved?.since ?? (mailbox.last_sync_at ? Math.floor((Date.parse(mailbox.last_sync_at)-60_000)/1000) : null);
  let pageToken = saved?.pageToken || null, page = 0, inserted = 0;
  do {
    const list = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
    list.searchParams.set('maxResults','25');
    if (since) list.searchParams.set('q',`after:${since}`);
    if (pageToken) list.searchParams.set('pageToken',pageToken);
    const data = await providerJson(list.toString(),{headers});
    for (const item of data.messages || []) {
      const exists = db.prepare('SELECT 1 FROM messages WHERE mailbox_id=? AND provider_message_id=?').get(mailbox.id,item.id);
      if (exists) continue;
      const full = await providerJson(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(item.id)}?format=full`,{headers});
      const h = gmailHeaders(full.payload || {});
      const plain = gmailBody(full.payload,'text/plain');
      const html = plain ? null : gmailBody(full.payload,'text/html');
      const result = ingestMessage(db,config.key,{userId:mailbox.user_id,mailboxId:mailbox.id,providerMessageId:item.id,sender:h.from || '',recipients:addressesFromHeader(h.to),subject:h.subject || '',text:plain || textFromHtml(html) || full.snippet || '',receivedAt:new Date(Number(full.internalDate || Date.now())).toISOString()});
      if (result.inserted) inserted++;
    }
    pageToken = data.nextPageToken || null;
    db.prepare('UPDATE mailboxes SET cursor=? WHERE id=?').run(pageToken?JSON.stringify({since,pageToken}):null,mailbox.id);
    page++;
    if (page >= 5 && pageToken) return {inserted,complete:false};
  } while (pageToken);
  return {inserted,complete:true};
}
async function syncMicrosoft(db,config,mailbox) {
  const token = await activeToken(db,config,mailbox);
  const headers = {Authorization:`Bearer ${token}`,Prefer:'outlook.body-content-type="text"'};
  let next = mailbox.cursor || 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$select=id,subject,from,toRecipients,receivedDateTime,body&$top=20';
  let pages = 0, inserted = 0;
  while (next) {
    const data = await providerJson(next,{headers});
    for (const item of data.value || []) {
      if (item['@removed'] || !item.id) continue;
      const recipient = (item.toRecipients || []).map(x=>x.emailAddress?.address).filter(Boolean);
      const body = item.body?.contentType?.toLowerCase() === 'html' ? textFromHtml(item.body.content) : String(item.body?.content || '');
      const result = ingestMessage(db,config.key,{userId:mailbox.user_id,mailboxId:mailbox.id,providerMessageId:item.id,sender:item.from?.emailAddress?.address || '',recipients:recipient,subject:item.subject || '',text:body,receivedAt:item.receivedDateTime || now()});
      if (result.inserted) inserted++;
    }
    next = data['@odata.nextLink'] || null;
    const cursor = data['@odata.deltaLink'] || next;
    if (cursor) db.prepare('UPDATE mailboxes SET cursor=? WHERE id=?').run(cursor,mailbox.id);
    pages++;
    if (pages >= 5 && next) break;
  }
  return {inserted,complete:!next};
}
export async function testImapConnection(input) {
  const client = new ImapFlow({host:input.host,port:input.port || 993,secure:true,auth:{user:input.username,pass:input.password},logger:false,tls:{rejectUnauthorized:true},connectionTimeout:15_000,greetingTimeout:15_000,socketTimeout:30_000});
  try { await client.connect(); await client.mailboxOpen('INBOX',{readOnly:true}); return true; }
  finally { if (client.usable) await client.logout().catch(()=>{}); }
}
async function syncImap(db,config,mailbox) {
  const input = JSON.parse(decrypt(mailbox.credential_cipher,config.key));
  const client = new ImapFlow({host:input.host,port:input.port,secure:true,auth:{user:input.username,pass:input.password},logger:false,tls:{rejectUnauthorized:true},connectionTimeout:15_000,greetingTimeout:15_000,socketTimeout:30_000});
  let inserted = 0;
  try {
    await client.connect();
    const info = await client.mailboxOpen('INBOX',{readOnly:true});
    const exists = info.exists || 0;
    if (exists) {
      const first = Math.max(1,exists-499);
      for await (const msg of client.fetch(`${first}:*`,{uid:true,source:{start:0,maxLength:2_000_000}})) {
        if (!msg.source) continue;
        const providerMessageId = `${info.uidValidity}:${msg.uid}`;
        if (db.prepare('SELECT 1 FROM messages WHERE mailbox_id=? AND provider_message_id=?').get(mailbox.id,providerMessageId)) continue;
        const parsed = await simpleParser(msg.source,{skipHtmlToText:false});
        const recipients = (parsed.to?.value || []).map(x=>x.address).filter(Boolean);
        const result = ingestMessage(db,config.key,{userId:mailbox.user_id,mailboxId:mailbox.id,providerMessageId,sender:parsed.from?.value?.[0]?.address || '',recipients,subject:parsed.subject || '',text:parsed.text || textFromHtml(parsed.html),receivedAt:(parsed.date || new Date()).toISOString()});
        if (result.inserted) inserted++;
      }
    }
  } finally { if (client.usable) await client.logout().catch(()=>{}); }
  return {inserted,complete:true};
}
const activeSync = new Set();
export async function syncMailbox(db, config, mailboxId, userId) {
  const mailbox = db.prepare('SELECT * FROM mailboxes WHERE id=? AND user_id=?').get(mailboxId,userId);
  if (!mailbox) throw new Error('Mailbox not found');
  if (mailbox.provider === 'domain') throw new Error('Domain mail arrives through the inbound webhook');
  if (activeSync.has(mailboxId)) throw new Error('Mailbox sync already running');
  activeSync.add(mailboxId);
  try {
    const result = mailbox.provider === 'google' ? await syncGoogle(db,config,mailbox) : mailbox.provider === 'microsoft' ? await syncMicrosoft(db,config,mailbox) : await syncImap(db,config,mailbox);
    db.prepare('UPDATE mailboxes SET status=?,last_error=NULL,last_sync_at=CASE WHEN ? THEN ? ELSE last_sync_at END WHERE id=?').run('connected',result.complete?1:0,now(),mailboxId);
    audit(db,userId,'mailbox.sync',mailboxId);
    return result;
  } catch (error) {
    const message = error.status === 401 || error.status === 403 ? 'Provider authorization expired or was revoked; reconnect this mailbox.' : 'Mailbox synchronization failed. Check provider access and server logs.';
    db.prepare('UPDATE mailboxes SET status=?,last_error=? WHERE id=?').run('error',message,mailboxId);
    console.error('sync error', mailbox.provider, mailbox.id, error.status || error.name || 'error');
    throw new Error(message);
  } finally { activeSync.delete(mailboxId); }
}
export async function revokeGoogle(db,config,mailbox) {
  if (mailbox.provider !== 'google' || !mailbox.credential_cipher) return null;
  const credential = JSON.parse(decrypt(mailbox.credential_cipher,config.key));
  if (!credential.refreshToken) return false;
  try { await providerFetch('https://oauth2.googleapis.com/revoke',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token:credential.refreshToken})},0); return true; }
  catch (error) { console.warn('Google revocation could not be confirmed',mailbox.id,error.status||error.name); return false; }
}
