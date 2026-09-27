import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { randomBytes, createHmac } from 'node:crypto';
import { chromium } from 'playwright';
import { createApp } from '../src/server.mjs';

const dir=mkdtempSync(join(tmpdir(),'mail-ui-smoke-'));
const config={dbPath:join(dir,'test.sqlite'),key:randomBytes(32),sessionPepper:randomBytes(32).toString('base64url'),webhookSecret:randomBytes(32).toString('base64url'),setupToken:randomBytes(32).toString('base64url'),trustedProxyIps:[],ownedDomain:'example.test',baseUrl:'http://127.0.0.1:3000',google:null,microsoft:null,smtpEnabled:false};
const app=createApp(config);
let browser;
try {
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  config.baseUrl=`http://127.0.0.1:${app.server.address().port}`;
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  page.on('response',response=>{if(response.status()>=500) errors.push(`HTTP ${response.status()} ${new URL(response.url()).pathname}`);});
  await page.goto(config.baseUrl);
  await page.getByLabel('Email').fill('owner@example.test');
  await page.getByLabel('Mật khẩu').fill('a strong test password');
  await page.getByLabel(/Mã thiết lập/).fill(config.setupToken);
  await page.getByRole('button',{name:'Khởi tạo không gian'}).click();
  await page.getByRole('heading',{name:/Máy sinh Gmail Dot Trick/}).waitFor();

  await page.getByLabel('Địa chỉ Gmail gốc').fill('owner@outlook.com');
  await page.getByRole('button',{name:/Bắt đầu sinh Dot Trick/}).click();
  await page.getByText(/Dot Trick chỉ dùng với địa chỉ @gmail.com/).waitFor();
  await page.getByLabel('Địa chỉ Gmail gốc').fill('owner@gmail.com');
  await page.getByRole('button',{name:/Bắt đầu sinh Dot Trick/}).click();
  await page.locator('.gen-addr').first().waitFor();
  const dotAddresses=(await page.locator('.gen-addr').allTextContents()).map(value=>value.replace(/^#\d+\s*/,''));
  if (dotAddresses.length!==15 || new Set(dotAddresses).size!==15 || dotAddresses.some(value=>{const [local,domain]=value.split('@');return `${local.replaceAll('.','')}@${domain}`!=='owner@gmail.com';})) throw new Error('Gmail dot variants are missing or repeated');
  if (await page.locator('#dot-mode option').count()!==2) throw new Error('Dot mode must show only All and Categorized');
  if (!(await page.locator('.variant-tag').allTextContents()).includes('Xen kẽ đều')) throw new Error('Combined dot variants did not show pattern labels');
  await page.locator('#dot-mode').selectOption('categorized');
  if (!(await page.locator('#dot-pattern-wrap').isVisible())) throw new Error('Categorized dot presets did not appear');
  await page.locator('#dot-pattern').selectOption('one_dot');
  await page.getByRole('button',{name:/Bắt đầu sinh Dot Trick/}).click();
  await page.getByRole('heading',{name:'Kết quả sinh (4)'}).waitFor();
  if ((await page.locator('.variant-tag').allTextContents()).some(value=>value!=='1 dấu chấm')) throw new Error('Categorized mode mixed dot patterns');
  if (!(await page.locator('[data-action="save-dots-to-backend"]').isDisabled())) throw new Error('Unconnected Gmail must not be saveable as a receiving mailbox');
  if (app.db.prepare('SELECT COUNT(*) AS n FROM mailboxes WHERE provider=?').get('google').n) throw new Error('Generator created a fake Gmail mailbox');

  await page.locator('[data-action="switch-gen-tab"][data-tab="plus"]').click();
  if (await page.locator('#plus-count').getAttribute('max')) throw new Error('Plus count still has an arbitrary HTML maximum');
  await page.locator('#plus-count').fill('999');
  await page.getByRole('button',{name:/Bắt đầu sinh Thẻ Plus/}).click();
  await page.getByRole('heading',{name:'Kết quả thẻ Plus (999)'}).waitFor();
  if (await page.locator('.gen-addr').count()!==200) throw new Error('Plus result paging did not keep the UI responsive');
  await page.locator('[data-action="plus-next"]').click();
  await page.getByText('Đang xem 201–400 / 999').waitFor();
  await page.locator('#plus-count').fill('2501');
  await page.getByRole('button',{name:/Bắt đầu sinh Thẻ Plus/}).click();
  await page.getByRole('heading',{name:'Kết quả thẻ Plus (2501)'}).waitFor();

  await page.locator('nav [data-page="connections"]').click();
  if (!(await page.getByRole('button',{name:'Kết nối Gmail'}).isDisabled())) throw new Error('Gmail OAuth must wait for client configuration');
  if (!(await page.getByRole('button',{name:'Kết nối Outlook / Hotmail'}).isDisabled())) throw new Error('Microsoft OAuth must wait for client configuration');
  await page.locator('nav [data-page="settings"]').click();
  await page.locator('form[data-form="account-credentials"]').waitFor();
  await page.locator('[data-action="clean-system"][data-mode="quick"]').last().click();
  await page.getByText(/Đã dọn \d+ địa chỉ hết hạn/).waitFor();
  await page.locator('nav [data-page="generator"]').click();

  await page.getByRole('button',{name:/Mail Tạm 1-Chạm/}).click();
  await page.getByRole('button',{name:/Tạm 15 phút/}).click();
  await page.getByText(/Đã tạo & sao chép:/).waitFor();
  const alias=app.db.prepare("SELECT address FROM aliases WHERE kind='domain' ORDER BY created_at DESC LIMIT 1").get();
  if (!alias) throw new Error('Temporary address was not saved');

  const payload={recipient:alias.address,from:'sender@example.org',subject:'Your verification code',text:'Your verification code is 981234',messageId:'smoke-1'};
  const raw=JSON.stringify(payload),timestamp=Math.floor(Date.now()/1000);
  const signature=createHmac('sha256',config.webhookSecret).update(`${timestamp}.`).update(raw).digest('hex');
  const response=await fetch(`${config.baseUrl}/api/v1/inbound`,{method:'POST',headers:{'Content-Type':'application/json','x-workspace-timestamp':String(timestamp),'x-workspace-signature':signature},body:raw});
  if(response.status!==201) throw new Error(`Inbound HTTP ${response.status}: ${await response.text()}`);
  await page.locator('nav [data-page="inbox"]').click();
  await page.getByRole('button',{name:/Your verification code/}).click();
  await page.getByText('981234',{exact:true}).waitFor();
  await page.waitForTimeout(3400);
  if(await page.locator('#toast').isVisible()) throw new Error('Toast should disappear after a short delay');
  if(process.env.INBOX_SCREENSHOT_PATH) await page.screenshot({path:process.env.INBOX_SCREENSHOT_PATH,fullPage:true});
  await page.setViewportSize({width:390,height:844});
  if(process.env.MOBILE_SCREENSHOT_PATH) await page.screenshot({path:process.env.MOBILE_SCREENSHOT_PATH,fullPage:true});
  if(errors.length) throw new Error('Browser errors: '+errors.join('; '));
  console.log('UI smoke passed: setup, real Gmail gating, provider controls, account settings, temporary domain alias, signed inbound and OTP display.');
} finally {
  if(browser) await browser.close();
  await app.close();
  const target=realpathSync(dir),root=realpathSync(tmpdir());
  if(!target.startsWith(root+sep) || !target.split(sep).at(-1).startsWith('mail-ui-smoke-')) throw new Error('Refusing to remove an unexpected smoke directory');
  if(process.env.KEEP_SMOKE_ARTIFACTS!=='1') rmSync(target,{recursive:true,force:true});
}

