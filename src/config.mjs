import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isIP } from 'node:net';
import { keyFromBase64 } from './crypto.mjs';
export function loadEnv(path = '.env') {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].trim();
  }
}
export function configFromEnv() {
  loadEnv();
  const baseUrl = new URL(process.env.PUBLIC_BASE_URL || 'http://127.0.0.1:3000');
  if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.pathname !== '/') throw new Error('PUBLIC_BASE_URL must be a base HTTP(S) URL');
  if (baseUrl.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(baseUrl.hostname)) throw new Error('HTTPS is required for a non-local PUBLIC_BASE_URL');
  const sessionPepper = process.env.SESSION_PEPPER || '';
  const webhookSecret = process.env.INBOUND_WEBHOOK_SECRET || '';
  const setupToken = process.env.SETUP_TOKEN || '';
  if (sessionPepper.length < 32 || webhookSecret.length < 32 || setupToken.length < 32) throw new Error('Run pnpm setup to create required secrets, including SETUP_TOKEN');
  const trustedProxyIps = (process.env.TRUSTED_PROXY_IPS || '').split(',').map(x => x.trim()).filter(Boolean);
  if (trustedProxyIps.some(x => !isIP(x))) throw new Error('TRUSTED_PROXY_IPS must contain IP addresses');
  const domain = (process.env.OWNED_MAIL_DOMAIN || '').trim().toLowerCase();
  if (domain && !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(domain)) throw new Error('Invalid OWNED_MAIL_DOMAIN');
  const autoBootstrapLocal=process.env.AUTO_BOOTSTRAP_LOCAL==='true';
  if (autoBootstrapLocal && !['localhost','127.0.0.1'].includes(baseUrl.hostname)) throw new Error('AUTO_BOOTSTRAP_LOCAL is only available on a loopback PUBLIC_BASE_URL');
  return {
    host: process.env.HOST || '127.0.0.1',
    port: Number(process.env.PORT || 3000),
    baseUrl: baseUrl.origin,
    dbPath: resolve(process.env.DATA_DIR || './data', 'workspace.sqlite'),
    key: keyFromBase64(process.env.DATA_ENCRYPTION_KEY),
    sessionPepper, webhookSecret, setupToken, trustedProxyIps,
    ownedDomain: domain,
    google: process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET ? { id: process.env.GOOGLE_CLIENT_ID, secret: process.env.GOOGLE_CLIENT_SECRET } : null,
    microsoft: process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET ? { id: process.env.MICROSOFT_CLIENT_ID, secret: process.env.MICROSOFT_CLIENT_SECRET } : null,
    autoBootstrapLocal,
    smtpEnabled:process.env.ENABLE_SMTP!=='false',
    smtpHost:process.env.SMTP_HOST || '127.0.0.1',
    smtpPort:Number(process.env.SMTP_PORT || 2525),
  };
}
