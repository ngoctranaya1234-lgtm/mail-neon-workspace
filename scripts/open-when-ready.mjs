import { get } from 'node:https';
import { spawn } from 'node:child_process';

const url = 'https://127.0.0.1:3000';
const chrome = process.argv[2] || '';

function ready() {
  return new Promise(resolve => {
    const request = get(`${url}/healthz`, { rejectUnauthorized: false, timeout: 2000 }, response => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on('error', () => resolve(false));
    request.on('timeout', () => { request.destroy(); resolve(false); });
  });
}

for (let attempt = 0; attempt < 120; attempt++) {
  if (await ready()) {
    const child = chrome
      ? spawn(chrome, [
          `--user-data-dir=${process.env.LOCALAPPDATA}\\MailNeonWorkspace\\ChromeProfile`,
          `--app=${url}`, '--allow-insecure-localhost', '--window-size=1280,820'
        ], { detached: true, stdio: 'ignore' })
      : spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' });
    try {
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      child.unref();
      process.exit(0);
    } catch (error) {
      console.error('[Browser] Could not open app:', error.message);
      process.exit(1);
    }
  }
  await new Promise(resolve => setTimeout(resolve, 500));
}
console.error('[Browser] Server did not become ready within 60 seconds. Open https://127.0.0.1:3000 manually.');
process.exit(1);
