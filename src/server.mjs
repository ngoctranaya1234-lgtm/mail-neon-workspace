import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createHmac, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { DatabaseSync, backup } from 'node:sqlite';
import { configFromEnv } from './config.mjs';
import { hashPassword, hashToken, randomToken, secureEqualHex, verifyPassword, encrypt, decrypt } from './crypto.mjs';
import { InputError, DOT_PATTERNS, generateCombinedDotVariants, generateDotVariants, generatePlusVariants, gmailCanonical, gmailDotVariants, gmailPlusAlias, normalizeEmail, ownedDomainAlias, extractOtp } from './domain.mjs';
import { audit, ingestMessage, messageForUser, now, openDatabase, publicMailbox } from './db.mjs';
import { finishOAuth, revokeGoogle, startOAuth, syncMailbox, testImapConnection } from './providers.mjs';
import { createSmtpServer } from './smtp.mjs';

const staticRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public');
class HttpError extends Error { constructor(status,code,message) { super(message); this.status=status; this.code=code; } }
const bad = (message,code='VALIDATION_ERROR') => new HttpError(400,code,message);
const forbidden = () => new HttpError(403,'FORBIDDEN','Access denied');
const notFound = () => new HttpError(404,'NOT_FOUND','Resource not found');
const json = (res,status,data) => { res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); res.end(JSON.stringify(data)); };
const data = (res,value,status=200) => json(res,status,{data:value});
const readBody = async (req,max=256_000) => {
  const chunks=[]; let size=0;
  for await (const chunk of req) { size+=chunk.length; if(size>max) throw new HttpError(413,'BODY_TOO_LARGE','Request body too large'); chunks.push(chunk); }
  return Buffer.concat(chunks);
};
const parseJson = buffer => { try { return JSON.parse(buffer.toString('utf8')); } catch { throw bad('Invalid JSON body'); } };
const cookies = header => Object.fromEntries(String(header||'').split(';').map(x=>x.trim().split('=')).filter(x=>x.length===2));
const integer = (value,fallback,min,max) => { const n=Number(value); return Number.isInteger(n) && n>=min && n<=max ? n : fallback; };
const cleanText = (value,max=120) => String(value||'').trim().slice(0,max);
const validDate = value => { if (!value) return null; const n=Date.parse(value); if (!Number.isFinite(n) || n<Date.now() || n>Date.now()+365*24*3600_000) throw bad('Invalid expiry'); return new Date(n).toISOString(); };
const dummyPasswordHash = hashPassword(randomToken());

export function createApp(config) {
  const db = openDatabase(config.dbPath);
  if (config.autoBootstrapLocal) {
    const hasUser = db.prepare('SELECT 1 FROM users LIMIT 1').get();
    if (!hasUser) {
      const id = randomUUID();
      db.exec('BEGIN IMMEDIATE');
      db.prepare('INSERT INTO users(id, email, password_hash, created_at) VALUES(?,?,?,?)')
        .run(id, 'owner@workspace.local', hashPassword(randomToken(48)), now());
      if (config.ownedDomain) {
        db.prepare("INSERT INTO mailboxes(id, user_id, provider, address, label, status, created_at) VALUES(?,?,?,?,?,'connected',?)")
          .run(randomUUID(), id, 'domain', `*@${config.ownedDomain}`, config.ownedDomain, now());
      }
      db.exec('COMMIT');
    }
  }
  const legacyOwner=db.prepare("SELECT id,password_hash FROM users WHERE email='owner@workspace.local'").get();
  if (legacyOwner && verifyPassword('workspace_owner_2026',legacyOwner.password_hash)) {
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(randomToken(48)),legacyOwner.id);
    console.warn('Rotated legacy local owner password; set your own password in Settings before remote access.');
  }
  db.prepare("DELETE FROM mailboxes WHERE provider='google' AND address='generator@gmail.com' AND credential_cipher IS NULL AND NOT EXISTS (SELECT 1 FROM aliases WHERE mailbox_id=mailboxes.id) AND NOT EXISTS (SELECT 1 FROM messages WHERE mailbox_id=mailboxes.id)").run();
  db.prepare("UPDATE mailboxes SET status='error',last_error='Connect this Gmail account through OAuth to receive mail' WHERE provider='google' AND address='generator@gmail.com' AND credential_cipher IS NULL").run();
  if (config.ownedDomain) {
    for (const user of db.prepare('SELECT id FROM users').all()) {
      db.prepare("INSERT OR IGNORE INTO mailboxes(id,user_id,provider,address,label,status,created_at) VALUES(?,?,?,?,?,'connected',?)")
        .run(randomUUID(),user.id,'domain',`*@${config.ownedDomain}`,config.ownedDomain,now());
    }
  }
  db.prepare("UPDATE mailboxes SET status='error',last_error='This domain is not configured on the server' WHERE provider='domain' AND address!=?").run(`*@${config.ownedDomain}`);
  const attempts = new Map();
  const clientAddress = req => {
    const peer = req.socket.remoteAddress || 'unknown';
    if (!config.trustedProxyIps?.includes(peer)) return peer;
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').at(-1)?.trim();
    return forwarded && isIP(forwarded) ? forwarded : peer;
  };
  const limit = (key,max=8,windowMs=15*60_000) => {
    const current=attempts.get(key) || {n:0,expires:Date.now()+windowMs};
    if (current.expires<Date.now()) {current.n=0;current.expires=Date.now()+windowMs;}
    current.n++; attempts.set(key,current);
    if (current.n>max) throw new HttpError(429,'RATE_LIMITED','Too many attempts. Try again later.');
  };
  const session = req => {
    const token = cookies(req.headers.cookie).workspace_session;
    if (token) {
      const tokenHash=hashToken(token,config.sessionPepper);
      const row=db.prepare('SELECT s.*,u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?').get(tokenHash,now());
      if (row) return {...row,tokenHash};
    }
    if (config.autoBootstrapLocal && ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(clientAddress(req)) && !req.headers['x-forwarded-for'] && !req.headers.forwarded && !req.headers['x-real-ip']) {
      const row = db.prepare('SELECT u.id as user_id, u.email FROM users u LIMIT 1').get();
      if (row) return { user_id: row.user_id, email: row.email, csrf_token: 'local-auto-csrf', tokenHash: 'local' };
    }
    return null;
  };
  const requireSession = req => session(req) || (()=>{throw new HttpError(401,'UNAUTHENTICATED','Sign in to continue');})();
  const requireCsrf = (req,s) => {
    if (config.autoBootstrapLocal && s.csrf_token === 'local-auto-csrf') return;
    const token=req.headers['x-csrf-token'];
    if (!token || !secureEqualHex(hashToken(String(token),config.sessionPepper),hashToken(s.csrf_token,config.sessionPepper))) throw forbidden();
  };
  const issueSession = (res,userId) => {
    const token=randomToken(); const csrf=randomToken();
    const expires=new Date(Date.now()+7*24*3600_000).toISOString();
    db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,created_at) VALUES(?,?,?,?,?)')
      .run(hashToken(token,config.sessionPepper),userId,csrf,expires,now());
    const secure=config.baseUrl.startsWith('https:') ? '; Secure' : '';
    res.setHeader('Set-Cookie',`workspace_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${secure}`);
    return { csrf };
  };
  const requestHandler = async (req,res) => {
    const requestId=randomUUID();
    res.setHeader('X-Request-ID',requestId);
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (config.baseUrl.startsWith('https:')) res.setHeader('Strict-Transport-Security','max-age=31536000; includeSubDomains');
    try {
      const origin=req.headers.origin;
      const isAllowedOrigin=origin && origin===config.baseUrl;
      if (origin && isAllowedOrigin) {
        res.setHeader('Access-Control-Allow-Origin',origin);
        res.setHeader('Access-Control-Allow-Credentials','true');
        res.setHeader('Access-Control-Allow-Methods','GET, POST, PATCH, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers','Content-Type, X-CSRF-Token');
      }
      if (req.method==='OPTIONS') {
        if (isAllowedOrigin) { res.writeHead(204); res.end(); return; }
        throw forbidden();
      }
      const url=new URL(req.url,config.baseUrl);
      const path=url.pathname;
      if (req.method==='GET' && path==='/healthz') { db.prepare('SELECT 1').get(); return data(res,{status:'ok'}); }
      if (!path.startsWith('/api/v1/')) {
        const file=path==='/' ? 'index.html' : path==='/app.js' ? 'app.js' : path==='/style.css' ? 'style.css' : path==='/manifest.webmanifest' ? 'manifest.webmanifest' : ['/icon.svg','/icon-192.png','/icon-512.png'].includes(path) ? path.slice(1) : null;
        if (!file || req.method!=='GET') throw notFound();
        const bytes=await readFile(join(staticRoot,file));
        res.writeHead(200,{'Content-Type':file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.svg')?'image/svg+xml':file.endsWith('.png')?'image/png':file.endsWith('.webmanifest')?'application/manifest+json':'text/css; charset=utf-8','Cache-Control':'no-store'});
        return res.end(bytes);
      }
      if (!['GET','HEAD'].includes(req.method)) {
        if (origin && !isAllowedOrigin) throw forbidden();
      }
      if (req.method==='GET' && path==='/api/v1/config') {
        const hasUser = !!db.prepare('SELECT 1 FROM users LIMIT 1').get();
        return data(res,{
          setupRequired: !hasUser && !config.autoBootstrapLocal,
          autoLogin: !!config.autoBootstrapLocal,
          providers:{google:!!config.google,microsoft:!!config.microsoft,imap:true,domain:!!config.ownedDomain},
          ownedDomain:config.ownedDomain,
          smtpPort: config.smtpPort || 2525,
          smtpEnabled: config.smtpEnabled === true
        });
      }
      if (req.method==='GET' && path==='/api/v1/system/metrics') {
        const totalAliases = db.prepare('SELECT COUNT(*) as count FROM aliases').get()?.count || 0;
        const totalMessages = db.prepare('SELECT COUNT(*) as count FROM messages').get()?.count || 0;
        const totalMailboxes = db.prepare('SELECT COUNT(*) as count FROM mailboxes').get()?.count || 0;
        const mem = process.memoryUsage();
        return data(res, {
          uptime: Math.round(process.uptime()),
          nodeVersion: process.version,
          platform: process.platform,
          memory: {
            heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024 * 100) / 100,
            heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024 * 100) / 100,
            rssMB: Math.round(mem.rss / 1024 / 1024 * 100) / 100
          },
          counts: {
            aliases: totalAliases,
            messages: totalMessages,
            mailboxes: totalMailboxes
          },
          smtpPort: config.smtpPort || 2525,
          smtpEnabled: config.smtpEnabled === true,
          timestamp: new Date().toISOString()
        });
      }
      if (req.method==='POST' && path==='/api/v1/loadtest/bench-generator') {
        const body = parseJson(await readBody(req));
        const email = body.email || 'benchmark.test@gmail.com';
        const count = Math.min(Math.max(Number(body.count) || 5000, 100), 100_000);
        const start = process.hrtime.bigint();
        const variants = generateDotVariants(email, { count, mode: 'all' });
        const end = process.hrtime.bigint();
        const durationNs = Number(end - start);
        const durationMs = durationNs / 1_000_000;
        const throughput = Math.round((variants.length / (durationMs / 1000)));
        return data(res, {
          count: variants.length,
          durationMs: Math.round(durationMs * 100) / 100,
          throughputPerSec: throughput,
          sample: variants.slice(0, 5)
        });
      }
      if (req.method==='POST' && path==='/api/v1/loadtest/bench-db') {
        const s = requireSession(req);
        requireCsrf(req, s);
        const body = parseJson(await readBody(req));
        const count = Math.min(Math.max(Number(body.count) || 500, 10), 5_000);
        const bench=new DatabaseSync(':memory:');
        try {
          bench.exec('CREATE TABLE bench(id INTEGER PRIMARY KEY,payload TEXT NOT NULL); BEGIN IMMEDIATE;');
          const stmt=bench.prepare('INSERT INTO bench(payload) VALUES(?)');
          const start=process.hrtime.bigint();
          for (let i=0;i<count;i++) stmt.run(`row-${i}`);
          bench.exec('COMMIT');
          const durationMs=Number(process.hrtime.bigint()-start)/1_000_000;
          return data(res,{inserted:bench.prepare('SELECT COUNT(*) AS n FROM bench').get().n,durationMs:Math.round(durationMs*100)/100,tps:Math.round(count/(durationMs/1000)),avgLatencyPerItemMs:Math.round(durationMs/count*1000)/1000,scope:'isolated-memory'});
        } finally { bench.close(); }
      }
      if (req.method==='POST' && path==='/api/v1/system/clean') {
        const s = requireSession(req);
        requireCsrf(req, s);
        const body=parseJson(await readBody(req));
        const mode=body.mode || 'quick';
        if (!['quick','full'].includes(mode)) throw bad('Unknown cleanup mode');
        let expiredAliasesDeleted=0,expiredSessionsDeleted=0,expiredOAuthDeleted=0,messagesDeleted=0,aliasesDeleted=0;
        let backupPath=null,walTruncated=false,vacuumed=false;
        if (mode==='full') {
          const user=db.prepare('SELECT password_hash FROM users WHERE id=?').get(s.user_id);
          const passwordOk=verifyPassword(String(body.password||''),user.password_hash);
          const setupOk=secureEqualHex(hashToken(String(body.setupToken||''),config.sessionPepper),hashToken(config.setupToken,config.sessionPepper));
          if (!passwordOk && !setupOk) throw new HttpError(401,'BAD_CREDENTIALS','Password or setup token is required before resetting data');
          const backupDir=join(dirname(config.dbPath),'backups');
          mkdirSync(backupDir,{recursive:true,mode:0o700});
          backupPath=join(backupDir,`before-reset-${new Date().toISOString().replaceAll(':','-')}.sqlite`);
          await backup(db,backupPath);
          messagesDeleted=db.prepare('DELETE FROM messages WHERE user_id=?').run(s.user_id).changes;
          aliasesDeleted=db.prepare('DELETE FROM aliases WHERE user_id=?').run(s.user_id).changes;
          expiredOAuthDeleted=db.prepare('DELETE FROM oauth_states WHERE user_id=?').run(s.user_id).changes;
        } else {
          expiredAliasesDeleted=db.prepare('DELETE FROM aliases WHERE user_id=? AND expires_at IS NOT NULL AND expires_at<?').run(s.user_id,now()).changes;
          expiredSessionsDeleted=db.prepare('DELETE FROM sessions WHERE expires_at<?').run(now()).changes;
          expiredOAuthDeleted=db.prepare('DELETE FROM oauth_states WHERE expires_at<?').run(now()).changes;
        }
        try {db.exec('PRAGMA wal_checkpoint(TRUNCATE)');walTruncated=true;} catch {}
        if (mode==='full') {try {db.exec('VACUUM');vacuumed=true;} catch {}}
        audit(db,s.user_id,`system.clean.${mode}`,s.user_id);
        return data(res,{mode,expiredAliasesDeleted,expiredSessionsDeleted,expiredOAuthDeleted,messagesDeleted,aliasesDeleted,backupPath,walTruncated,vacuumed,cleanedAt:now()});
      }
      if (req.method==='POST' && path==='/api/v1/generator/dots') {
        const body=parseJson(await readBody(req));
        if (!body.email) throw bad('Vui lòng nhập địa chỉ email');
        const count = body.count === undefined ? 50 : Number(body.count);
        if (!Number.isSafeInteger(count) || count < 1 || count > 2000) throw bad('Mỗi lần sinh Dot Trick phải có 1–2.000 biến thể');
        const mode = body.mode || 'all';
        let pattern = null;
        let details;
        if (mode === 'combined') details = generateCombinedDotVariants(body.email, { count, useGooglemail: !!body.useGooglemail });
        else {
          pattern = mode === 'categorized' ? body.pattern : mode === 'all' ? 'binary' : mode;
          if (!DOT_PATTERNS.includes(pattern)) throw bad('Kiểu sinh dấu chấm không hợp lệ');
          details = generateDotVariants(body.email, { count, mode: pattern === 'binary' ? 'all' : pattern, useGooglemail: !!body.useGooglemail })
            .map(address => ({ address, categories: [pattern] }));
        }
        const variants = details.map(item => item.address);
        const canonical = gmailCanonical(body.email);
        const base = canonical.split('@')[0];
        const spaces = Math.max(0, base.length - 1);
        const totalTheory = (1n << BigInt(spaces)).toString();
        const totalVariants = ((1n << BigInt(spaces)) - 1n).toString();
        return data(res, { canonical, base, spaces, totalTheory, totalVariants, count: variants.length, mode, pattern, variants, details });
      }
      if (req.method==='POST' && path==='/api/v1/generator/plus') {
        const body=parseJson(await readBody(req));
        if (!body.email) throw bad('Vui lòng nhập địa chỉ email');
        const count = body.count === undefined ? 20 : Number(body.count);
        if (!Number.isSafeInteger(count) || count < 1 || count > 2000) throw bad('Mỗi lô Thẻ Plus phải có 1–2.000 địa chỉ');
        const variants = generatePlusVariants(body.email, {
          preset: body.preset || 'numbers',
          customTag: body.customTag || '',
          count,
          offset: body.offset ?? 0
        });
        return data(res, { count: variants.length, offset: String(body.offset ?? 0), nextOffset: (BigInt(String(body.offset ?? 0)) + BigInt(variants.length)).toString(), variants });
      }
      if (req.method==='POST' && path==='/api/v1/generator/save-batch') {
        const s = requireSession(req);
        requireCsrf(req, s);
        const body = parseJson(await readBody(req));
        const addresses = Array.isArray(body.addresses) ? body.addresses : [];
        if (!addresses.length || addresses.length > 2000) throw bad('Select 1–2000 Gmail variants');
        const categories = body.categories;
        if (categories !== undefined && (!Array.isArray(categories) || categories.length !== addresses.length || categories.some(row => !Array.isArray(row) || row.length > DOT_PATTERNS.length || row.some(code => !DOT_PATTERNS.includes(code))))) throw bad('Variant categories are invalid');
        if (typeof body.mailboxId!=='string' || !body.mailboxId) throw bad('Connect the owning Gmail account through OAuth first');
        const mailbox = db.prepare('SELECT * FROM mailboxes WHERE id=? AND user_id=?').get(body.mailboxId,s.user_id);
        if (!mailbox || mailbox.provider!=='google' || !mailbox.credential_cipher) throw bad('Connect the owning Gmail account through OAuth first');
        let canonical;
        try { canonical=gmailCanonical(mailbox.address); } catch { throw bad('Only personal gmail.com mailboxes support Gmail dot and plus aliases'); }
        const normalized=addresses.map(raw=>{
          const address=normalizeEmail(raw);
          if (gmailCanonical(address)!==canonical || address===mailbox.address) throw bad('Variant does not belong to the selected Gmail mailbox');
          const local=address.split('@')[0];
          if (!local.includes('.') && !local.includes('+') && !address.endsWith('@googlemail.com')) throw bad('Address is not a dot, plus or googlemail variant');
          return {address,kind:local.includes('+')?'plus':'dot'};
        });
        let inserted = 0;
        db.exec('BEGIN IMMEDIATE');
        try {
          const insertStmt = db.prepare('INSERT OR IGNORE INTO aliases(id, user_id, mailbox_id, address, kind, purpose, source, status, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)');
          for (const [index,{address,kind}] of normalized.entries()) {
            const purpose = categories ? `Gmail Dot Trick: ${categories[index].join(', ')}` : cleanText(body.purpose,120);
            const r = insertStmt.run(randomUUID(), s.user_id, mailbox.id, address, kind, cleanText(purpose,120), cleanText(body.source,120), 'active', now());
            if (r.changes) inserted++;
          }
          db.exec('COMMIT');
        } catch (e) { db.exec('ROLLBACK'); throw e; }
        return data(res, { inserted, total: addresses.length });
      }
      if (req.method==='POST' && path==='/api/v1/setup') {
        if (!String(req.headers['content-type']||'').startsWith('application/json')) throw bad('Content-Type must be application/json');
        limit(`setup:${clientAddress(req)}`,5);
        if (db.prepare('SELECT 1 FROM users LIMIT 1').get()) throw new HttpError(409,'ALREADY_SETUP','Owner account already exists');
        const body=parseJson(await readBody(req));
        if (!secureEqualHex(hashToken(String(body.setupToken || ''),config.sessionPepper),hashToken(config.setupToken,config.sessionPepper))) throw new HttpError(401,'BAD_SETUP_TOKEN','Invalid setup token');
        const email=normalizeEmail(body.email);
        const password=String(body.password||'');
        if (password.length<12 || password.length>1024) throw bad('Password must be 12–1024 characters');
        const id=randomUUID();
        const passwordHash=hashPassword(password);
        db.exec('BEGIN IMMEDIATE');
        try {
          if (db.prepare('SELECT 1 FROM users LIMIT 1').get()) throw new HttpError(409,'ALREADY_SETUP','Owner account already exists');
          db.prepare('INSERT INTO users(id,email,password_hash,created_at) VALUES(?,?,?,?)').run(id,email,passwordHash,now());
          if (config.ownedDomain) db.prepare('INSERT INTO mailboxes(id,user_id,provider,address,label,status,created_at) VALUES(?,?,?,?,?,?,?)').run(randomUUID(),id,'domain',`*@${config.ownedDomain}`,config.ownedDomain,'connected',now());
          audit(db,id,'account.setup',id);
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        const s=issueSession(res,id);
        return data(res,{user:{id,email},csrf:s.csrf},201);
      }
      if (req.method==='POST' && path==='/api/v1/login') {
        if (!String(req.headers['content-type']||'').startsWith('application/json')) throw bad('Content-Type must be application/json');
        limit(`login:${clientAddress(req)}`,12);
        const body=parseJson(await readBody(req));
        const email=String(body.email||'').trim().toLowerCase();
        const user=db.prepare('SELECT * FROM users WHERE email=?').get(email);
        const ok=verifyPassword(String(body.password||''),user?.password_hash || dummyPasswordHash);
        if (!user || !ok) throw new HttpError(401,'BAD_CREDENTIALS','Invalid email or password');
        audit(db,user.id,'account.login',user.id);
        const s=issueSession(res,user.id);
        return data(res,{user:{id:user.id,email:user.email},csrf:s.csrf});
      }
      if (req.method==='POST' && path==='/api/v1/inbound') {
        const raw=await readBody(req,512_000);
        const timestamp=Number(req.headers['x-workspace-timestamp']);
        if (!Number.isInteger(timestamp) || Math.abs(Date.now()-timestamp*1000)>5*60_000) throw new HttpError(401,'BAD_SIGNATURE','Webhook timestamp invalid');
        const expected=createHmac('sha256',config.webhookSecret).update(`${timestamp}.`).update(raw).digest('hex');
        if (!secureEqualHex(expected,req.headers['x-workspace-signature'])) throw new HttpError(401,'BAD_SIGNATURE','Webhook signature invalid');
        const body=parseJson(raw);
        const recipient=normalizeEmail(body.recipient);
        const messageId=cleanText(body.messageId,250);
        if (!messageId || !config.ownedDomain || !recipient.endsWith(`@${config.ownedDomain}`)) throw bad('Unknown recipient or missing message ID');
        const alias=db.prepare(`SELECT a.*,b.provider FROM aliases a JOIN mailboxes b ON b.id=a.mailbox_id WHERE a.address=? AND a.status='active' AND b.provider='domain' AND (a.expires_at IS NULL OR a.expires_at>?)`).get(recipient,now());
        if (!alias) throw notFound();
        const from=normalizeEmail(body.from);
        const result=ingestMessage(db,config.key,{userId:alias.user_id,mailboxId:alias.mailbox_id,providerMessageId:messageId,sender:from,recipients:[recipient],subject:cleanText(body.subject,500),text:String(body.text||'').slice(0,200_000),receivedAt:body.receivedAt && Number.isFinite(Date.parse(body.receivedAt)) ? new Date(body.receivedAt).toISOString() : now()});
        if (result.inserted) audit(db,alias.user_id,'message.ingest',result.id);
        return data(res,result,result.inserted?201:200);
      }
      const oauthCallback=path.match(/^\/api\/v1\/oauth\/(google|microsoft)\/callback$/);
      if (req.method==='GET' && oauthCallback) {
        const s=requireSession(req);
        try { await finishOAuth(db,config,oauthCallback[1],url.searchParams.get('state'),url.searchParams.get('code'),s.user_id); res.writeHead(302,{Location:'/?connected=1'}); return res.end(); }
        catch (error) { console.error('OAuth callback',oauthCallback[1],error.status||error.name); res.writeHead(302,{Location:'/?connection_error=1'}); return res.end(); }
      }
      const s=requireSession(req);
      const userId=s.user_id;
      if (!['GET','HEAD'].includes(req.method)) requireCsrf(req,s);
      if (req.method==='GET' && path==='/api/v1/me') return data(res,{user:{id:userId,email:s.email},csrf:s.csrf_token,autoSession:s.tokenHash==='local'});
      if (req.method==='POST' && path==='/api/v1/logout') {
        db.prepare('DELETE FROM sessions WHERE token_hash=?').run(s.tokenHash);
        res.setHeader('Set-Cookie','workspace_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
        audit(db,userId,'account.logout',userId);
        return data(res,{loggedOut:true});
      }
      if (req.method==='DELETE' && path==='/api/v1/account') {
        const body=parseJson(await readBody(req));
        const user=db.prepare('SELECT password_hash FROM users WHERE id=?').get(userId);
        if (!user || !verifyPassword(String(body.password||''),user.password_hash)) throw new HttpError(401,'BAD_CREDENTIALS','Password is incorrect');
        const googleBoxes=db.prepare("SELECT * FROM mailboxes WHERE user_id=? AND provider='google'").all(userId);
        const unconfirmed=[];
        for (const box of googleBoxes) if (!(await revokeGoogle(db,config,box))) unconfirmed.push(box.address);
        db.prepare('DELETE FROM audit_events WHERE user_id=?').run(userId);
        db.prepare('DELETE FROM users WHERE id=?').run(userId);
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        res.setHeader('Set-Cookie','workspace_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
        return data(res,{deleted:true,unconfirmedRevocations:unconfirmed});
      }
      if (req.method==='POST' && path==='/api/v1/account/credentials') {
        const body=parseJson(await readBody(req));
        const email=normalizeEmail(body.email);
        const password=String(body.password||'');
        if (password.length<12 || password.length>1024) throw bad('Password must be 12–1024 characters');
        const user=db.prepare('SELECT password_hash FROM users WHERE id=?').get(userId);
        const currentOk=verifyPassword(String(body.currentPassword||''),user.password_hash);
        const setupOk=secureEqualHex(hashToken(String(body.setupToken||''),config.sessionPepper),hashToken(config.setupToken,config.sessionPepper));
        if (!currentOk && !setupOk) throw new HttpError(401,'BAD_CREDENTIALS','Current password or setup token is required');
        db.prepare('UPDATE users SET email=?,password_hash=? WHERE id=?').run(email,hashPassword(password),userId);
        audit(db,userId,'account.credentials',userId);
        return data(res,{email,updated:true});
      }
      if (req.method==='GET' && path==='/api/v1/summary') {
        const mailboxCount=db.prepare('SELECT COUNT(*) AS n FROM mailboxes WHERE user_id=?').get(userId).n;
        const aliasCount=db.prepare("SELECT COUNT(*) AS n FROM aliases WHERE user_id=? AND status='active' AND (expires_at IS NULL OR expires_at>?)").get(userId,now()).n;
        const messageCount=db.prepare('SELECT COUNT(*) AS n FROM messages WHERE user_id=?').get(userId).n;
        const unreadCount=db.prepare('SELECT COUNT(*) AS n FROM messages WHERE user_id=? AND is_read=0').get(userId).n;
        return data(res,{mailboxes:mailboxCount,aliases:aliasCount,messages:messageCount,unread:unreadCount});
      }
      if (req.method==='GET' && path==='/api/v1/mailboxes') return data(res,db.prepare('SELECT * FROM mailboxes WHERE user_id=? ORDER BY created_at DESC').all(userId).map(publicMailbox));
      if (req.method==='POST' && path==='/api/v1/mailboxes/imap') {
        const body=parseJson(await readBody(req));
        const host=String(body.host||'').trim().toLowerCase();
        const port=integer(body.port,993,1,65535);
        const username=cleanText(body.username,254); const password=String(body.password||'');
        const address=normalizeEmail(body.address);
        if (!/^[a-z0-9.-]+$/.test(host) || !host.includes('.') || !username || !password) throw bad('IMAP host, username and password are required');
        const input={host,port,username,password};
        try { await testImapConnection(input); } catch { throw bad('Could not connect to IMAP with TLS and the supplied credentials','IMAP_CONNECTION_FAILED'); }
        const id=randomUUID();
        try { db.prepare('INSERT INTO mailboxes(id,user_id,provider,address,label,credential_cipher,status,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id,userId,'imap',address,address,encrypt(JSON.stringify(input),config.key),'connected',now()); }
        catch (error) { if (String(error).includes('UNIQUE')) throw new HttpError(409,'DUPLICATE','Mailbox is already connected'); throw error; }
        audit(db,userId,'mailbox.connect',id);
        return data(res,{id,address},201);
      }
      const oauthStart=path.match(/^\/api\/v1\/oauth\/(google|microsoft)\/start$/);
      if (req.method==='POST' && oauthStart) {
        const provider=oauthStart[1];
        if (!config[provider]) throw new HttpError(503,'PROVIDER_NOT_CONFIGURED',`${provider==='google'?'Gmail':'Outlook / Hotmail'} chưa được cấu hình OAuth. Xem README để thêm Client ID và Client Secret.`);
        return data(res,{url:startOAuth(db,config,userId,provider)});
      }
      const syncRoute=path.match(/^\/api\/v1\/mailboxes\/([^/]+)\/sync$/);
      if (req.method==='POST' && syncRoute) {
        const box=db.prepare('SELECT provider,credential_cipher FROM mailboxes WHERE id=? AND user_id=?').get(syncRoute[1],userId);
        if (!box) throw notFound();
        if (box.provider==='domain') throw bad('Mail domain riêng nhận qua webhook hoặc cổng SMTP, không đồng bộ hộp thư.');
        if (!box.credential_cipher) throw bad('Hãy kết nối lại hộp thư này trước khi đồng bộ.');
        try { return data(res,await syncMailbox(db,config,syncRoute[1],userId)); }
        catch (error) {
          if (error.message==='Mailbox sync already running') throw new HttpError(409,'SYNC_IN_PROGRESS','Hộp thư đang đồng bộ; hãy thử lại sau.');
          if (error.message?.startsWith('Mailbox synchronization failed.') || error.message?.startsWith('Provider authorization expired')) throw new HttpError(502,'SYNC_FAILED',error.message);
          throw error;
        }
      }
      const mailboxRoute=path.match(/^\/api\/v1\/mailboxes\/([^/]+)$/);
      if (req.method==='DELETE' && mailboxRoute) {
        const box=db.prepare('SELECT * FROM mailboxes WHERE id=? AND user_id=?').get(mailboxRoute[1],userId);
        if (!box) throw notFound();
        if (box.provider==='domain') throw bad('Owned-domain mailbox is managed by server configuration');
        const revocation=await revokeGoogle(db,config,box);
        db.prepare('DELETE FROM mailboxes WHERE id=? AND user_id=?').run(box.id,userId);
        audit(db,userId,'mailbox.disconnect',box.id);
        return data(res,{deleted:true,providerRevocationConfirmed:revocation});
      }
      if (req.method==='GET' && path==='/api/v1/aliases/preview') {
        const box=db.prepare('SELECT * FROM mailboxes WHERE id=? AND user_id=?').get(url.searchParams.get('mailboxId'),userId);
        if (!box || box.provider!=='google' || !box.credential_cipher || !box.address.endsWith('@gmail.com')) throw bad('Connect a gmail.com mailbox first');
        const candidates=gmailDotVariants(box.address,integer(url.searchParams.get('count'),20,1,50));
        const existing=new Set(db.prepare('SELECT address FROM aliases WHERE user_id=?').all(userId).map(x=>x.address));
        return data(res,candidates.filter(x=>!existing.has(x)));
      }
      if (req.method==='GET' && path==='/api/v1/aliases') {
        const status=url.searchParams.get('status'); const q=cleanText(url.searchParams.get('q'),100).toLowerCase();
        const limit=integer(url.searchParams.get('limit'),100,1,200); const offset=integer(url.searchParams.get('offset'),0,0,1000000);
        const rows=db.prepare('SELECT a.*,b.provider,b.address AS mailbox_address FROM aliases a JOIN mailboxes b ON b.id=a.mailbox_id WHERE a.user_id=? AND (? IS NULL OR a.status=?) AND (a.address LIKE ? OR a.purpose LIKE ? OR a.source LIKE ?) ORDER BY a.created_at DESC LIMIT ? OFFSET ?')
          .all(userId,status,status,`%${q}%`,`%${q}%`,`%${q}%`,limit,offset);
        return data(res,{items:rows,limit,offset});
      }
      if (req.method==='POST' && path==='/api/v1/aliases') {
        limit(`alias:${userId}`,60,60*60_000);
        const body=parseJson(await readBody(req));
        const box=db.prepare('SELECT * FROM mailboxes WHERE id=? AND user_id=?').get(body.mailboxId,userId);
        if (!box) throw notFound();
        let address;
        if (body.kind==='dot' && box.provider==='google' && box.credential_cipher && box.address.endsWith('@gmail.com')) {
          address=normalizeEmail(body.address);
          if (!address.split('@')[0].includes('.') || address===box.address || gmailCanonical(address)!==gmailCanonical(box.address) || address.includes('+')) throw bad('Dot variant does not belong to this Gmail mailbox');
        } else if (body.kind==='plus' && box.provider==='google' && box.credential_cipher && box.address.endsWith('@gmail.com')) address=gmailPlusAlias(box.address,body.tag);
        else if (body.kind==='domain' && box.provider==='domain' && config.ownedDomain) address=ownedDomainAlias(config.ownedDomain,body.local || randomToken(8).toLowerCase());
        else throw bad('Alias type is not supported by this mailbox');
        const id=randomUUID();
        try { db.prepare('INSERT INTO aliases(id,user_id,mailbox_id,address,kind,purpose,source,status,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,userId,box.id,address,body.kind,cleanText(body.purpose,120),cleanText(body.source,120),'active',validDate(body.expiresAt),now()); }
        catch (error) { if (String(error).includes('UNIQUE')) throw new HttpError(409,'DUPLICATE','Alias already exists'); throw error; }
        audit(db,userId,'alias.create',id);
        return data(res,{id,address},201);
      }
      const aliasRoute=path.match(/^\/api\/v1\/aliases\/([^/]+)$/);
      if (aliasRoute && req.method==='PATCH') {
        const row=db.prepare('SELECT * FROM aliases WHERE id=? AND user_id=?').get(aliasRoute[1],userId); if (!row) throw notFound();
        const body=parseJson(await readBody(req));
        const status=body.status===undefined?row.status:body.status;
        const leak=body.leakStatus===undefined?row.leak_status:body.leakStatus;
        const spam=body.spamStatus===undefined?row.spam_status:body.spamStatus;
        if (!['active','archived'].includes(status) || !['unknown','suspected','confirmed'].includes(leak) || !['none','observed','high'].includes(spam)) throw bad('Invalid alias state');
        const purpose=body.purpose===undefined?row.purpose:cleanText(body.purpose,120);
        const source=body.source===undefined?row.source:cleanText(body.source,120);
        const notes=body.notes===undefined?row.notes:cleanText(body.notes,1000);
        const expiry=body.expiresAt===undefined?row.expires_at:validDate(body.expiresAt);
        db.prepare('UPDATE aliases SET status=?,purpose=?,source=?,notes=?,leak_status=?,spam_status=?,expires_at=? WHERE id=? AND user_id=?')
          .run(status,purpose,source,notes,leak,spam,expiry,row.id,userId);
        audit(db,userId,'alias.update',row.id); return data(res,{id:row.id,status});
      }
      if (aliasRoute && req.method==='DELETE') {
        const result=db.prepare('DELETE FROM aliases WHERE id=? AND user_id=?').run(aliasRoute[1],userId);
        if (!result.changes) throw notFound(); audit(db,userId,'alias.delete',aliasRoute[1]); return data(res,{deleted:true});
      }
      if (req.method==='GET' && path==='/api/v1/messages') {
        const q=cleanText(url.searchParams.get('q'),100).toLowerCase();
        const mailboxId=url.searchParams.get('mailboxId');
        const unreadOnly=url.searchParams.get('unread')==='1'?1:0;
        const limit=integer(url.searchParams.get('limit'),50,1,100); const offset=integer(url.searchParams.get('offset'),0,0,1000000);
        const rows=db.prepare('SELECT m.id,m.mailbox_id,m.sender,m.recipients,m.subject,m.received_at,m.is_read,b.address AS mailbox_address,a.address AS alias_address FROM messages m JOIN mailboxes b ON b.id=m.mailbox_id LEFT JOIN aliases a ON a.id=m.alias_id WHERE m.user_id=? AND (? IS NULL OR m.mailbox_id=?) AND (?=0 OR m.is_read=0) AND (m.subject LIKE ? OR m.sender LIKE ? OR m.recipients LIKE ?) ORDER BY m.received_at DESC,m.id DESC LIMIT ? OFFSET ?')
          .all(userId,mailboxId,mailboxId,unreadOnly,`%${q}%`,`%${q}%`,`%${q}%`,limit,offset).map(x=>{
            let recipients;
            try { recipients=JSON.parse(x.recipients); } catch { recipients=[x.recipients]; }
            return {...x,recipients};
          });
        return data(res,{items:rows,limit,offset});
      }
      if (req.method==='POST' && path==='/api/v1/messages/read-all') {
        const result=db.prepare('UPDATE messages SET is_read=1 WHERE user_id=? AND is_read=0').run(userId);
        return data(res,{updated:result.changes});
      }
      if (req.method==='DELETE' && path==='/api/v1/messages') {
        const result=db.prepare('DELETE FROM messages WHERE user_id=?').run(userId);
        audit(db,userId,'messages.clear_all',userId);
        return data(res,{deleted:result.changes});
      }
      if (req.method==='GET' && path==='/api/v1/messages/export') {
        const rows=db.prepare('SELECT m.id,m.sender,m.recipients,m.subject,m.body_cipher,m.received_at,m.is_read,b.address AS mailbox_address,a.address AS alias_address FROM messages m JOIN mailboxes b ON b.id=m.mailbox_id LEFT JOIN aliases a ON a.id=m.alias_id WHERE m.user_id=? ORDER BY m.received_at DESC LIMIT 1000')
          .all(userId).map(x => {
            let recipients;
            try { recipients = JSON.parse(x.recipients); } catch { recipients = [x.recipients]; }
            let text = '';
            try { text = decrypt(x.body_cipher, config.key); } catch {}
            const otp = extractOtp(`${x.subject}\n${text}`, x.received_at, true);
            return {
              id: x.id,
              sender: x.sender,
              recipients,
              subject: x.subject,
              received_at: x.received_at,
              is_read: x.is_read,
              mailbox_address: x.mailbox_address,
              alias_address: x.alias_address,
              otp: otp?.code || null,
              snippet: text.slice(0, 200)
            };
          });
        audit(db,userId,'messages.export',userId);
        return data(res, { version: 1, exportedAt: now(), items: rows, count: rows.length });
      }
      const messageRoute=path.match(/^\/api\/v1\/messages\/([^/]+)$/);
      if (messageRoute && req.method==='GET') {
        const message=messageForUser(db,config.key,userId,messageRoute[1]);
        if (!message) throw notFound();
        return data(res,{...message,otp:extractOtp(`${message.subject}\n${message.text}`,message.received_at)});
      }
      if (messageRoute && req.method==='PATCH') {
        const result=db.prepare('UPDATE messages SET is_read=1 WHERE id=? AND user_id=?').run(messageRoute[1],userId);
        if (!result.changes) throw notFound(); return data(res,{read:true});
      }
      if (messageRoute && req.method==='DELETE') {
        const result=db.prepare('DELETE FROM messages WHERE id=? AND user_id=?').run(messageRoute[1],userId);
        if (!result.changes) throw notFound(); audit(db,userId,'message.delete',messageRoute[1]); return data(res,{deleted:true});
      }
      if (req.method==='GET' && path==='/api/v1/export') {
        const mailboxes=db.prepare('SELECT provider,address,label,status,created_at FROM mailboxes WHERE user_id=?').all(userId);
        const aliases=db.prepare('SELECT address,kind,purpose,source,status,expires_at,last_used_at,created_at FROM aliases WHERE user_id=?').all(userId);
        audit(db,userId,'account.export',userId);
        return data(res,{version:1,exportedAt:now(),mailboxes,aliases});
      }
      if (req.method==='GET' && path==='/api/v1/audit') return data(res,db.prepare('SELECT id,action,target_id,created_at FROM audit_events WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(userId));
      throw notFound();
    } catch (error) {
      const status=error instanceof HttpError?error.status:error instanceof InputError?400:500;
      const code=error instanceof HttpError?error.code:error instanceof InputError?'VALIDATION_ERROR':'INTERNAL_ERROR';
      const message=error instanceof HttpError || error instanceof InputError?error.message:'An internal error occurred';
      if (status===500) console.error('request error',requestId,error);
      if (!res.headersSent) json(res,status,{error:{code,message,request_id:requestId}});
      else res.end();
    }
  };
  let server;
  const pfxFile = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'cert.pfx');
  const isHttps = config.baseUrl.startsWith('https:') && existsSync(pfxFile);
  if (isHttps) {
    server = createHttpsServer({ pfx: readFileSync(pfxFile), passphrase: 'workspace-tls' }, requestHandler);
  } else {
    server = createHttpServer(requestHandler);
  }
  const timer=setInterval(async()=>{
    const rows=db.prepare("SELECT id,user_id FROM mailboxes WHERE provider!='domain' AND credential_cipher IS NOT NULL AND status!='disabled'").all();
    for (const row of rows) await syncMailbox(db,config,row.id,row.user_id).catch(()=>{});
  },5*60_000);
  let smtpServer = null;
  const smtpPort = config.smtpPort || 2525;
  if (config.smtpEnabled) {
    try {
      smtpServer = createSmtpServer(db, config);
      smtpServer.on('error',error=>console.error('[SMTP] Listener error:',error.code || error.message));
      smtpServer.listen(smtpPort, config.smtpHost || '127.0.0.1', () => {
        console.log(`[SMTP] Local inbound ready on ${config.smtpHost || '127.0.0.1'}:${smtpPort}`);
      });
    } catch (e) {
      console.log('[SMTP] Note:', e.message);
    }
  }
  return {
    server, db, close: async () => {
      clearInterval(timer);
      if (smtpServer) await new Promise(r => smtpServer.close(r)).catch(() => {});
      await new Promise(resolve => server.close(resolve));
      db.close();
    }
  };
}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const config=configFromEnv();
  const app=createApp(config);
  app.server.listen(config.port,config.host,()=>console.log(`Mail Identity Workspace listening at ${config.baseUrl}`));
  process.on('SIGINT',()=>app.close().then(()=>process.exit(0)));
  process.on('SIGTERM',()=>app.close().then(()=>process.exit(0)));
}
