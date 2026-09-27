import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { messageForUser, openDatabase } from '../src/db.mjs';
import { startOAuth, finishOAuth, syncMailbox } from '../src/providers.mjs';

function fixture(provider) {
  const dir=mkdtempSync(join(tmpdir(),'mail-provider-test-'));
  const db=openDatabase(join(dir,'test.sqlite'));
  const userId=randomUUID();
  db.prepare('INSERT INTO users(id,email,password_hash,created_at) VALUES(?,?,?,?)').run(userId,'owner@example.test','hash',new Date().toISOString());
  const config={key:randomBytes(32),sessionPepper:'pepper-'.repeat(8),baseUrl:'http://127.0.0.1:3000',google:provider==='google'?{id:'google-client',secret:'google-secret'}:null,microsoft:provider==='microsoft'?{id:'microsoft-client',secret:'microsoft-secret'}:null};
  return {db,userId,config,close:()=>{db.close();rmSync(dir,{recursive:true,force:true});}};
}
const response = value => new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}});
test('Google OAuth state, minimal scope and real sync adapter contract',async()=>{
  const f=fixture('google');const previous=globalThis.fetch;
  try {
    const authorization=new URL(startOAuth(f.db,f.config,f.userId,'google'));
    assert.equal(authorization.hostname,'accounts.google.com');
    assert.equal(authorization.searchParams.get('scope'),'https://www.googleapis.com/auth/gmail.readonly');
    assert.equal(authorization.searchParams.get('code_challenge_method'),'S256');
    const state=authorization.searchParams.get('state');
    let calls=[];
    globalThis.fetch=async (url,options={})=>{
      calls.push(String(url));
      if(String(url).includes('/token')) return response({access_token:'google-access',refresh_token:'google-refresh',expires_in:3600});
      if(String(url).endsWith('/profile')) return response({emailAddress:'User.Name@gmail.com'});
      if(String(url).includes('/messages/') && String(url).includes('format=full')) return response({id:'g-1',internalDate:String(Date.now()),payload:{headers:[{name:'From',value:'sender@example.org'},{name:'To',value:'user.name@gmail.com'},{name:'Subject',value:'Your OTP'}],mimeType:'text/plain',body:{data:Buffer.from('Your OTP is 654321').toString('base64url')}}});
      if(String(url).includes('/messages')) return response({messages:[{id:'g-1'}]});
      throw new Error(`Unexpected URL ${url}`);
    };
    await assert.rejects(()=>finishOAuth(f.db,f.config,'google',state,'code',randomUUID()),/state/);
    const mailbox=await finishOAuth(f.db,f.config,'google',state,'code',f.userId);
    assert.equal(mailbox.address,'user.name@gmail.com');
    assert.equal(f.db.prepare('SELECT credential_cipher FROM mailboxes WHERE id=?').get(mailbox.id).credential_cipher.includes('google-refresh'),false);
    assert.deepEqual(await syncMailbox(f.db,f.config,mailbox.id,f.userId),{inserted:1,complete:true});
    assert.deepEqual(await syncMailbox(f.db,f.config,mailbox.id,f.userId),{inserted:0,complete:true});
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,1);
    assert.ok(calls.some(x=>x.includes('gmail.googleapis.com')));
  } finally {globalThis.fetch=previous;f.close();}
});
test('Microsoft OAuth and delta cursor ingest without duplicate mail',async()=>{
  const f=fixture('microsoft');const previous=globalThis.fetch;
  try {
    const authorization=new URL(startOAuth(f.db,f.config,f.userId,'microsoft'));
    assert.equal(authorization.searchParams.get('scope'),'offline_access User.Read Mail.Read');
    const state=authorization.searchParams.get('state');
    globalThis.fetch=async url=>{
      const value=String(url);
      if(value.endsWith('/token')) return response({access_token:'ms-access',refresh_token:'ms-refresh',expires_in:3600});
      if(value.includes('/me?$select=')) return response({mail:'owner@outlook.com'});
      if(value.includes('/messages/delta')) return response({value:[{id:'m-1',subject:'Login code',from:{emailAddress:{address:'sender@example.org'}},toRecipients:[{emailAddress:{address:'owner@outlook.com'}}],body:{contentType:'text',content:'Login code: 719228'+'x'.repeat(200_000)},receivedDateTime:new Date().toISOString()}],'@odata.deltaLink':'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=abc'});
      throw new Error(`Unexpected URL ${url}`);
    };
    const mailbox=await finishOAuth(f.db,f.config,'microsoft',state,'code',f.userId);
    assert.equal(mailbox.address,'owner@outlook.com');
    assert.deepEqual(await syncMailbox(f.db,f.config,mailbox.id,f.userId),{inserted:1,complete:true});
    const message=f.db.prepare('SELECT id FROM messages WHERE mailbox_id=?').get(mailbox.id);
    assert.equal(messageForUser(f.db,f.config.key,f.userId,message.id).text.length,200_000);
    assert.match(f.db.prepare('SELECT cursor FROM mailboxes WHERE id=?').get(mailbox.id).cursor,/deltatoken/);
    assert.deepEqual(await syncMailbox(f.db,f.config,mailbox.id,f.userId),{inserted:0,complete:true});
  } finally {globalThis.fetch=previous;f.close();}
});
test('oversized provider JSON is rejected before mailbox creation',async()=>{
  const f=fixture('google');const previous=globalThis.fetch;
  try {
    const state=new URL(startOAuth(f.db,f.config,f.userId,'google')).searchParams.get('state');
    globalThis.fetch=async()=>response({access_token:'token',padding:'x'.repeat(8_000_000)});
    await assert.rejects(()=>finishOAuth(f.db,f.config,'google',state,'code',f.userId),/size limit/);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM mailboxes').get().n,0);
  } finally {globalThis.fetch=previous;f.close();}
});
