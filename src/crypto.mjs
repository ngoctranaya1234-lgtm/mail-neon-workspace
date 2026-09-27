import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export function hashToken(token, pepper) { return createHmac('sha256', pepper).update(token).digest('hex'); }
export function hashPassword(password) {
  const salt = randomBytes(16).toString('base64url');
  return `scrypt:${salt}:${scryptSync(password, salt, 64).toString('base64url')}`;
}
export function verifyPassword(password, stored) {
  const [algorithm, salt, digest] = String(stored).split(':');
  if (algorithm !== 'scrypt' || !salt || !digest) return false;
  const expected = Buffer.from(digest, 'base64url');
  const actual = scryptSync(password, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export function keyFromBase64(value) {
  const key = Buffer.from(value || '', 'base64url');
  if (key.length !== 32) throw new Error('DATA_ENCRYPTION_KEY must be a 32-byte base64url value');
  return key;
}
export function encrypt(plain, key) {
  if (plain == null) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${data.toString('base64url')}`;
}
export function decrypt(value, key) {
  if (value == null) return null;
  const [version, iv, tag, data] = String(value).split('.');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('Unsupported encrypted value');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}
export function secureEqualHex(left, right) {
  if (!/^[a-f0-9]{64}$/i.test(String(left)) || !/^[a-f0-9]{64}$/i.test(String(right))) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}
