import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const path = '.env';
if (existsSync(path)) { console.error('.env already exists; setup did not overwrite it.'); process.exit(1); }
const template = readFileSync('.env.example', 'utf8');
const secret = () => randomBytes(32).toString('base64url');
const content = template.replace(/^DATA_ENCRYPTION_KEY=$/m, `DATA_ENCRYPTION_KEY=${secret()}`)
  .replace(/^SESSION_PEPPER=$/m, `SESSION_PEPPER=${secret()}`)
  .replace(/^INBOUND_WEBHOOK_SECRET=$/m, `INBOUND_WEBHOOK_SECRET=${secret()}`)
  .replace(/^SETUP_TOKEN=$/m, `SETUP_TOKEN=${secret()}`);
writeFileSync(path, content, { flag: 'wx', mode: 0o600 });
console.log('Created .env with fresh secrets. Enter SETUP_TOKEN from this file when creating the owner account. Edit provider and domain settings when ready.');
