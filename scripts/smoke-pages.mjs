import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'pages');
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = createServer((req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const target = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (target !== root && !target.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    const file = statSync(target).isDirectory() ? join(target, 'index.html') : target;
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' }).end(readFileSync(file));
  } catch { res.writeHead(404).end(); }
});
let browser;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.goto(origin);
  await page.getByLabel('Địa chỉ Gmail gốc').fill('nganhut3@gmail.com');
  await page.getByRole('button', { name: /Bắt đầu sinh/ }).click();
  await page.getByText('Đã sinh 50 biến thể Dot Trick.', { exact: false }).waitFor();
  const addresses = await page.locator('.row-address').allTextContents();
  assert.equal(addresses.length, 50);
  assert.equal(new Set(addresses).size, 50);
  assert.ok(addresses.every(address => address.split('@')[0].replaceAll('.', '') === 'nganhut3'));
  assert.ok((await page.locator('.tag').allTextContents()).includes('Xen kẽ đều'));
  await page.locator('#dot-mode').selectOption('categorized');
  await page.locator('#dot-pattern').selectOption('two_dots');
  await page.getByRole('button', { name: /Bắt đầu sinh/ }).click();
  assert.equal(await page.locator('.row-address').count(), 21);
  assert.ok((await page.locator('.tag').allTextContents()).every(text => text === '2 dấu chấm'));
  await page.getByRole('tab', { name: /Thẻ Plus/ }).click();
  await page.locator('#plus-count').fill('2501');
  await page.getByRole('button', { name: /Bắt đầu sinh/ }).click();
  await page.getByText('Hoàn tất 2.501 thẻ Plus.', { exact: false }).waitFor();
  assert.equal(await page.locator('.row-address').count(), 100);
  await page.locator('#next').click();
  assert.equal(await page.locator('#page-label').textContent(), 'Trang 2 / 26');
  assert.deepEqual(errors, []);
  if (process.env.PAGES_SCREENSHOT_PATH) await page.screenshot({ path: process.env.PAGES_SCREENSHOT_PATH, fullPage: true });
  console.log('GitHub Pages UI smoke passed: mobile layout, Dot categories, unique aliases, Plus 2501 and result paging.');
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
