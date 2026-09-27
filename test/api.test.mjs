import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { once } from 'node:events';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createApp } from '../src/server.mjs';
import { hashPassword } from '../src/crypto.mjs';

async function fixture(overrides={}) {
  const dir=mkdtempSync(join(tmpdir(),'mail-identity-test-'));
  const config={dbPath:join(dir,'test.sqlite'),key:randomBytes(32),sessionPepper:randomBytes(32).toString('base64url'),webhookSecret:randomBytes(32).toString('base64url'),setupToken:randomBytes(32).toString('base64url'),trustedProxyIps:[],ownedDomain:'example.test',baseUrl:'http://127.0.0.1:3000',google:null,microsoft:null,smtpEnabled:false,...overrides};
  const app=createApp(config);
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const close=async()=>{await app.close();rmSync(dir,{recursive:true,force:true});};
  return {app,config,base,close};
}
async function call(base,path,{method='GET',body,csrf,cookie,headers={}}={}) {
  const response=await fetch(`${base}/api/v1${path}`,{method,headers:{...headers,...(body!==undefined?{'Content-Type':'application/json'}:{}),...(csrf?{'X-CSRF-Token':csrf}:{}),...(cookie?{Cookie:cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,json:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
test('owner setup, authorization, signed inbound, dedupe and inbox',async()=>{
  const f=await fixture();
  try {
    let r=await call(f.base,'/config');assert.equal(r.json.data.setupRequired,true);
    r=await call(f.base,'/setup',{method:'POST',body:{email:'owner@example.test',password:'a strong test password'}});assert.equal(r.status,401);
    r=await call(f.base,'/setup',{method:'POST',body:{email:'owner@example.test',password:'a strong test password',setupToken:'wrong'}});assert.equal(r.status,401);
    r=await call(f.base,'/setup',{method:'POST',body:{email:'owner@example.test',password:'a strong test password',setupToken:f.config.setupToken}});
    assert.equal(r.status,201);const cookie=r.cookie;const csrf=r.json.data.csrf;
    r=await call(f.base,'/setup',{method:'POST',body:{email:'other@example.test',password:'a strong test password',setupToken:f.config.setupToken}});assert.equal(r.status,409);
    r=await call(f.base,'/me',{cookie});assert.equal(r.json.data.csrf,csrf);
    r=await call(f.base,'/aliases',{method:'POST',cookie,body:{kind:'domain',mailboxId:'invalid',local:'otp'}});assert.equal(r.status,403);
    r=await call(f.base,'/mailboxes',{cookie});const mailbox=r.json.data.find(x=>x.provider==='domain');assert.ok(mailbox);
    r=await call(f.base,'/aliases',{method:'POST',cookie,csrf,body:{kind:'domain',mailboxId:mailbox.id,local:'otp',purpose:'Tests'}});
    assert.equal(r.status,201);assert.equal(r.json.data.address,'otp@example.test');const aliasId=r.json.data.id;
    r=await call(f.base,`/aliases/${aliasId}`,{method:'PATCH',cookie,csrf,body:{purpose:'Verification',source:'example.org',notes:'Tracked',leakStatus:'suspected',spamStatus:'observed'}});
    assert.equal(r.status,200);
    r=await call(f.base,'/aliases',{cookie});assert.equal(r.json.data.items[0].leak_status,'suspected');assert.equal(r.json.data.items[0].notes,'Tracked');
    const inbound={recipient:'otp@example.test',from:'sender@example.org',subject:'Verification code',text:'Your verification code is 847291',messageId:'message-1'};
    const raw=JSON.stringify(inbound);const timestamp=Math.floor(Date.now()/1000);
    const signature=createHmac('sha256',f.config.webhookSecret).update(`${timestamp}.`).update(raw).digest('hex');
    r=await call(f.base,'/inbound',{method:'POST',body:inbound,headers:{'x-workspace-timestamp':String(timestamp),'x-workspace-signature':'0'.repeat(64)}});assert.equal(r.status,401);
    r=await call(f.base,'/inbound',{method:'POST',body:inbound,headers:{'x-workspace-timestamp':String(timestamp),'x-workspace-signature':signature}});
    assert.equal(r.status,201);const messageId=r.json.data.id;
    r=await call(f.base,'/inbound',{method:'POST',body:inbound,headers:{'x-workspace-timestamp':String(timestamp),'x-workspace-signature':signature}});assert.equal(r.status,200);assert.equal(r.json.data.inserted,false);
    r=await call(f.base,'/messages?q=Verification',{cookie});assert.equal(r.json.data.items.length,1);
    r=await call(f.base,`/messages/${messageId}`,{cookie});assert.equal(r.json.data.otp.code,'847291');assert.equal(r.json.data.text,'Your verification code is 847291');
    r=await call(f.base,'/messages?unread=1',{cookie});assert.equal(r.json.data.items.length,1);
    r=await call(f.base,'/messages/read-all',{method:'POST',cookie,csrf});assert.equal(r.json.data.updated,1);
    r=await call(f.base,'/messages?unread=1',{cookie});assert.equal(r.json.data.items.length,0);
    r=await call(f.base,'/messages/export',{cookie});assert.equal(r.status,200);assert.equal(r.json.data.items.length,1);assert.equal(r.json.data.items[0].otp,'847291');
    r=await call(f.base,'/messages',{method:'DELETE',cookie,csrf});assert.equal(r.status,200);assert.equal(r.json.data.deleted,1);
    r=await call(f.base,'/messages',{cookie});assert.equal(r.json.data.items.length,0);
    const second=randomUUID();
    assert.throws(()=>f.app.db.prepare('INSERT INTO users(id,email,password_hash,created_at) VALUES(?,?,?,?)').run(second,'second@example.test',hashPassword('another password'),new Date().toISOString()),/UNIQUE/);
    r=await call(f.base,`/messages/${messageId}`);assert.equal(r.status,401);
    r=await call(f.base,'/export',{cookie});assert.equal(JSON.stringify(r.json.data).includes('847291'),false);
    r=await call(f.base,'/logout',{method:'POST',cookie,csrf});assert.equal(r.status,200);
    r=await call(f.base,'/me',{cookie});assert.equal(r.status,401);
    r=await call(f.base,'/login',{method:'POST',body:{email:'owner@example.test',password:'a strong test password'}});
    const newCookie=r.cookie;const newCsrf=r.json.data.csrf;
    r=await call(f.base,'/account',{method:'DELETE',cookie:newCookie,csrf:newCsrf,body:{password:'wrong'}});assert.equal(r.status,401);
    r=await call(f.base,'/account',{method:'DELETE',cookie:newCookie,csrf:newCsrf,body:{password:'a strong test password'}});assert.equal(r.status,200);
    r=await call(f.base,'/config');assert.equal(r.json.data.setupRequired,true);
  } finally {await f.close();}
});
test('an in-flight setup request cannot create a second owner',async()=>{
  const f=await fixture();
  let socket;
  try {
    const port=f.app.server.address().port;
    const payload=JSON.stringify({email:'second@example.test',password:'another strong password',setupToken:f.config.setupToken});
    socket=connect(port,'127.0.0.1');
    await once(socket,'connect');
    socket.write(`POST /api/v1/setup HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n`);
    await new Promise(resolve=>setTimeout(resolve,30));
    const first=await call(f.base,'/setup',{method:'POST',body:{email:'owner@example.test',password:'a strong test password',setupToken:f.config.setupToken}});
    assert.equal(first.status,201);
    socket.end(payload);
    let response='';
    for await (const chunk of socket) response+=chunk.toString();
    assert.match(response,/^HTTP\/1\.1 409 /);
    assert.equal(f.app.db.prepare('SELECT COUNT(*) AS n FROM users').get().n,1);
  } finally {socket?.destroy();await f.close();}
});
test('trusted proxy client addresses have separate login limits',async()=>{
  const f=await fixture({trustedProxyIps:['127.0.0.1']});
  try {
    const setup=await call(f.base,'/setup',{method:'POST',body:{email:'owner@example.test',password:'a strong test password',setupToken:f.config.setupToken}});
    assert.equal(setup.status,201);
    for (let i=0;i<12;i++) {
      const attempt=await call(f.base,'/login',{method:'POST',body:{email:'owner@example.test',password:'wrong'},headers:{'X-Forwarded-For':'198.51.100.10'}});
      assert.equal(attempt.status,401);
    }
    const blocked=await call(f.base,'/login',{method:'POST',body:{email:'owner@example.test',password:'wrong'},headers:{'X-Forwarded-For':'198.51.100.10'}});
    assert.equal(blocked.status,429);
    const owner=await call(f.base,'/login',{method:'POST',body:{email:'owner@example.test',password:'a strong test password'},headers:{'X-Forwarded-For':'198.51.100.11'}});
    assert.equal(owner.status,200);
  } finally {await f.close();}
});
test('domain alias address stays unique even in legacy multi-owner data',async()=>{
  const f=await fixture();
  try {
    const db=f.app.db;const stamp=new Date().toISOString();
    db.exec('DROP INDEX users_single_owner');
    const ownerIds=[randomUUID(),randomUUID()];const mailboxIds=[randomUUID(),randomUUID()];
    for (let i=0;i<2;i++) {
      db.prepare('INSERT INTO users(id,email,password_hash,created_at) VALUES(?,?,?,?)').run(ownerIds[i],`owner${i}@example.test`,'hash',stamp);
      db.prepare('INSERT INTO mailboxes(id,user_id,provider,address,label,status,created_at) VALUES(?,?,?,?,?,?,?)').run(mailboxIds[i],ownerIds[i],'domain','*@example.test','example.test','connected',stamp);
    }
    const insert=db.prepare('INSERT INTO aliases(id,user_id,mailbox_id,address,kind,purpose,source,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)');
    insert.run(randomUUID(),ownerIds[0],mailboxIds[0],'otp@example.test','domain','','','active',stamp);
    assert.throws(()=>insert.run(randomUUID(),ownerIds[1],mailboxIds[1],'otp@example.test','domain','','','active',stamp),/UNIQUE/);
  } finally {await f.close();}
});

test('system metrics and load test benchmark endpoints respond accurately', async () => {
  const f = await fixture();
  try {
    const metrics = await call(f.base, '/system/metrics');
    assert.equal(metrics.status, 200);
    assert.equal(metrics.json.data.smtpPort, 2525);
    assert.ok(metrics.json.data.memory.heapUsedMB > 0);

    const bench = await call(f.base, '/loadtest/bench-generator', {
      method: 'POST',
      body: { count: 1000, email: 'performance.stress.benchmark.test@gmail.com' }
    });
    assert.equal(bench.status, 200);
    assert.equal(bench.json.data.count, 1000);
    assert.ok(bench.json.data.throughputPerSec > 0);
  } finally { await f.close(); }
});

test('invalid email inputs return validation errors instead of server errors', async () => {
  const f = await fixture({ autoBootstrapLocal: true, ownedDomain: '' });
  try {
    for (const path of ['/generator/dots', '/generator/plus', '/loadtest/bench-generator']) {
      const response = await call(f.base, path, { method: 'POST', body: { email: 'name@outlook.com', count: 10 } });
      assert.equal(response.status, 400);
      assert.equal(response.json.error.code, 'VALIDATION_ERROR');
      assert.match(response.json.error.message, /gmail\.com|googlemail\.com/);
    }
    const oauth = await call(f.base, '/oauth/google/start', { method: 'POST' });
    assert.equal(oauth.status, 503);
    assert.equal(oauth.json.error.code, 'PROVIDER_NOT_CONFIGURED');
    const sync = await call(f.base, '/mailboxes/unknown/sync', { method: 'POST' });
    assert.equal(sync.status, 404);
  } finally { await f.close(); }
});

test('generator API combines and categorizes dots and pages Plus beyond 100', async()=>{
  const f=await fixture({autoBootstrapLocal:true,ownedDomain:''});
  try {
    let r=await call(f.base,'/generator/dots',{method:'POST',body:{email:'nganhut3@gmail.com',count:50,mode:'combined'}});
    assert.equal(r.status,200);
    assert.equal(r.json.data.variants.length,50);
    assert.equal(new Set(r.json.data.variants).size,50);
    assert.deepEqual(new Set(r.json.data.details.flatMap(item=>item.categories)),new Set(['binary','random','one_dot','two_dots','alternating']));
    r=await call(f.base,'/generator/dots',{method:'POST',body:{email:'nganhut3@gmail.com',count:50,mode:'categorized',pattern:'one_dot'}});
    assert.equal(r.status,200);
    assert.equal(r.json.data.variants.length,7);
    assert.ok(r.json.data.details.every(item=>item.categories[0]==='one_dot'));
    r=await call(f.base,'/generator/plus',{method:'POST',body:{email:'owner@gmail.com',preset:'social',count:999}});
    assert.equal(r.status,200);
    assert.equal(r.json.data.variants.length,999);
    assert.equal(r.json.data.nextOffset,'999');
    r=await call(f.base,'/generator/plus',{method:'POST',body:{email:'owner@gmail.com',preset:'social',count:1,offset:'999'}});
    assert.equal(r.status,200);
    assert.equal(r.json.data.variants[0],'owner+apple50@gmail.com');
  } finally {await f.close();}
});

test('generated aliases require their real connected Gmail mailbox and database benchmark leaves user data untouched', async () => {
  const f=await fixture({autoBootstrapLocal:true,ownedDomain:''});
  try {
    let r=await call(f.base,'/mailboxes');
    assert.equal(r.json.data.length,0);
    r=await call(f.base,'/generator/save-batch',{method:'POST',body:{addresses:['o.w.n.e.r@gmail.com']}});
    assert.equal(r.status,400);
    assert.equal(f.app.db.prepare('SELECT COUNT(*) AS n FROM mailboxes').get().n,0);
    const id=randomUUID();
    f.app.db.prepare("INSERT INTO mailboxes(id,user_id,provider,address,label,credential_cipher,status,created_at) VALUES(?,(SELECT id FROM users LIMIT 1),'google','owner@gmail.com','Owner','connected-credential','connected',?)").run(id,new Date().toISOString());
    r=await call(f.base,'/generator/save-batch',{method:'POST',body:{mailboxId:id,addresses:['other@gmail.com']}});
    assert.equal(r.status,400);
    r=await call(f.base,'/generator/save-batch',{method:'POST',body:{mailboxId:id,addresses:['o.w.n.e.r@gmail.com','owner@googlemail.com']}});
    assert.equal(r.status,200);assert.equal(r.json.data.inserted,2);
    r=await call(f.base,'/loadtest/bench-db',{method:'POST',body:{count:100}});
    assert.equal(r.status,200);assert.equal(r.json.data.inserted,100);
    assert.equal(f.app.db.prepare('SELECT COUNT(*) AS n FROM aliases').get().n,2);
  } finally {await f.close();}
});

test('local owner can set a private password using the setup token',async()=>{
  const f=await fixture({autoBootstrapLocal:true,ownedDomain:''});
  try {
    let r=await call(f.base,'/account/credentials',{method:'POST',body:{email:'owner@example.test',password:'a new strong password',setupToken:'wrong'}});
    assert.equal(r.status,401);
    r=await call(f.base,'/account/credentials',{method:'POST',body:{email:'owner@example.test',password:'a new strong password',setupToken:f.config.setupToken}});
    assert.equal(r.status,200);
    r=await call(f.base,'/login',{method:'POST',body:{email:'owner@example.test',password:'a new strong password'}});
    assert.equal(r.status,200);
    assert.equal(r.json.data.token,undefined);
  } finally {await f.close();}
});

test('system clean endpoint purges temporary data and expired aliases', async () => {
  const f = await fixture();
  try {
    const setup = await call(f.base, '/setup', {
      method: 'POST',
      body: { email: 'cleaner@example.test', password: 'a strong test password', setupToken: f.config.setupToken }
    });
    assert.equal(setup.status, 201);
    const csrf = setup.json.data.csrf;
    const cookie = setup.cookie;

    // Quick clean
    const quickClean = await call(f.base, '/system/clean', {
      method: 'POST',
      csrf,
      cookie,
      body: { mode: 'quick' }
    });
    assert.equal(quickClean.status, 200);
    assert.equal(quickClean.json.data.mode, 'quick');
    assert.equal(quickClean.json.data.walTruncated, true);
    assert.equal(typeof quickClean.json.data.expiredOAuthDeleted, 'number');

    // Full reset requires owner proof and creates a recoverable backup.
    const denied = await call(f.base, '/system/clean', {
      method: 'POST',
      csrf,
      cookie,
      body: { mode: 'full' }
    });
    assert.equal(denied.status,401);
    const fullClean = await call(f.base, '/system/clean', {
      method: 'POST',csrf,cookie,
      body: { mode: 'full', password:'a strong test password' }
    });
    assert.equal(fullClean.status, 200);
    assert.equal(fullClean.json.data.mode, 'full');
    assert.ok(fullClean.json.data.backupPath);
  } finally { await f.close(); }
});




