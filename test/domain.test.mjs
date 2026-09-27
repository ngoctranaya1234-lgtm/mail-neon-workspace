import test from 'node:test';
import assert from 'node:assert/strict';
import { gmailCanonical, gmailDotVariants, gmailPlusAlias, extractOtp, ownedDomainAlias, generateCombinedDotVariants, generateDotVariants, generatePlusVariants } from '../src/domain.mjs';
import { decrypt, encrypt, hashPassword, keyFromBase64, verifyPassword } from '../src/crypto.mjs';
import { randomBytes } from 'node:crypto';

test('Gmail canonicalization and variants keep one underlying mailbox',()=>{
  assert.equal(gmailCanonical('First.Last+news@gmail.com'),'firstlast@gmail.com');
  assert.deepEqual(gmailDotVariants('ab@gmail.com',20),['a.b@gmail.com']);
  assert.equal(new Set(gmailDotVariants('abcd@gmail.com',50)).size,7);
  assert.equal(gmailPlusAlias('first.last@gmail.com','News_1'),'firstlast+news_1@gmail.com');
  assert.throws(()=>gmailCanonical('first.last@example.com'));
  assert.throws(()=>gmailPlusAlias('a@gmail.com','bad tag'));
  assert.equal(ownedDomainAlias('example.com','inbox-123'),'inbox-123@example.com');

  // Test full dot trick generator
  const dotRes = generateDotVariants('testuser@gmail.com', { count: 100, mode: 'all', useGooglemail: false });
  assert.ok(Array.isArray(dotRes));
  assert.ok(dotRes.length > 0);
  assert.ok(dotRes.every(v => v.replace(/\./g, '').startsWith('testuser@')));

  // Test googlemail option
  const gmRes = generateDotVariants('user@gmail.com', { count: 10, mode: 'all', useGooglemail: true });
  assert.ok(gmRes.some(v => v.endsWith('@googlemail.com')));

  // Test plus tag presets
  const plusRes = generatePlusVariants('user@gmail.com', { preset: 'social', count: 10 });
  assert.ok(Array.isArray(plusRes));
  assert.ok(plusRes.length >= 6);
  assert.ok(plusRes.some(v => v.includes('+facebook@') || v.includes('+tiktok@')));

  const numRes = generatePlusVariants('user@gmail.com', { preset: 'numbers', count: 20 });
  assert.equal(numRes.length, 20);
  assert.ok(numRes[0].includes('+001@'));
});
test('combined Dot Trick samples distinct addresses from every available pattern',()=>{
  const runs=Array.from({length:3},()=>generateCombinedDotVariants('nganhut3@gmail.com',{count:50}));
  for (const rows of runs) {
    assert.equal(rows.length,50);
    assert.equal(new Set(rows.map(row=>row.address)).size,50);
    assert.ok(rows.every(row=>gmailCanonical(row.address)==='nganhut3@gmail.com'));
    assert.deepEqual(new Set(rows.flatMap(row=>row.categories)),new Set(['binary','random','one_dot','two_dots','alternating']));
    assert.ok(rows.some(row=>row.address==='n.g.a.n.h.u.t.3@gmail.com' && row.categories.includes('alternating')));
  }
  assert.ok(runs.some((rows,index)=>index>0 && rows.map(row=>row.address).join()!==runs[0].map(row=>row.address).join()));
  assert.deepEqual(generateDotVariants('a@gmail.com',{mode:'random',count:50}),[]);
  assert.deepEqual(new Set(generateDotVariants('abc@gmail.com',{mode:'random',count:50})),new Set(generateDotVariants('abc@gmail.com',{mode:'all',count:50})));
});
test('Plus generator accepts 999 entries and continues without duplicates across pages',()=>{
  const first=generatePlusVariants('owner@gmail.com',{preset:'social',count:999});
  const next=generatePlusVariants('owner@gmail.com',{preset:'social',count:1,offset:'999'});
  assert.equal(first.length,999);
  assert.equal(new Set([...first,...next]).size,1000);
  assert.equal(generatePlusVariants('owner@gmail.com',{preset:'numbers',count:1,offset:'999'})[0],'owner+1000@gmail.com');
  assert.throws(()=>generatePlusVariants('owner@gmail.com',{preset:'social',count:2001}),/2.000/);
});
test('OTP candidates require context and recency',()=>{
  const current=new Date().toISOString();
  assert.equal(extractOtp('Your verification code is 123456',current).code,'123456');
  assert.equal(extractOtp('849201 is your security verification code',current).code,'849201');
  assert.equal(extractOtp('Mã bảo mật đăng nhập của bạn là 638201',current).code,'638201');
  assert.equal(extractOtp('Mã kích hoạt của bạn là 992817',current).code,'992817');
  assert.equal(extractOtp('Receipt number 123456',current),null);
  assert.equal(extractOtp('Your OTP is 123456',new Date(Date.now()-20*60_000).toISOString()),null);
});
test('encryption and password hashing reject tampering and wrong passwords',()=>{
  const key=keyFromBase64(randomBytes(32).toString('base64url'));
  const cipher=encrypt('secret mail body',key);
  assert.equal(decrypt(cipher,key),'secret mail body');
  assert.throws(()=>decrypt(cipher.slice(0,-2)+'ab',key));
  const hash=hashPassword('a strong password');
  assert.equal(verifyPassword('a strong password',hash),true);
  assert.equal(verifyPassword('wrong password',hash),false);
});
