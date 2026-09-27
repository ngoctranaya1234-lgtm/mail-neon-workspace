// Web Crypto is available in Node.js 24+ and secure browser contexts, so the
// alias rules can be shared by the server and the GitHub Pages generator.
function randomInt(minOrMax, maybeMax) {
  const min = maybeMax === undefined ? 0 : minOrMax;
  const max = maybeMax === undefined ? minOrMax : maybeMax;
  const range = max - min;
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || range < 1 || range > 0x100000000) {
    throw new RangeError('Invalid random range');
  }
  const limit = Math.floor(0x100000000 / range) * range;
  const sample = new Uint32Array(1);
  do { globalThis.crypto.getRandomValues(sample); } while (sample[0] >= limit);
  return min + (sample[0] % range);
}

function randomHex(size) {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(size));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export class InputError extends Error {
  constructor(message) { super(message); this.name = 'InputError'; }
}

export function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(email)) {
    throw new InputError('Địa chỉ email không hợp lệ');
  }
  return email;
}

export function gmailCanonical(value) {
  const email = normalizeEmail(value);
  const [local, domain] = email.split('@');
  if (domain !== 'gmail.com' && domain !== 'googlemail.com') {
    throw new InputError('Tính năng Gmail Dot Trick và Plus yêu cầu domain gmail.com hoặc googlemail.com');
  }
  const base = local.split('+')[0].replaceAll('.', '');
  if (!base || base.length > 30 || !/^[a-z0-9]+$/.test(base)) {
    throw new InputError('Tên tài khoản Gmail chỉ chứa chữ cái a-z và số 0-9');
  }
  return `${base}@gmail.com`;
}

/**
 * Sinh danh sách Gmail Dot Trick với nhiều chế độ:
 * - 'all': thứ tự nhị phân chuẩn (2^(n-1))
 * - 'random': xáo trộn ngẫu nhiên
 * - 'one_dot': chỉ các biến thể có đúng 1 dấu chấm
 * - 'two_dots': chỉ các biến thể có đúng 2 dấu chấm
 * - 'alternating': dấu chấm xen kẽ (ví dụ a.b.c.d)
 */
export function generateDotVariants(email, { count = 50, mode = 'all', useGooglemail = false } = {}) {
  const canonical = gmailCanonical(email);
  const base = canonical.split('@')[0];
  const targetDomain = useGooglemail ? 'googlemail.com' : 'gmail.com';
  
  if (!['all','random','one_dot','two_dots','alternating'].includes(mode)) throw new InputError('Kiểu sinh dấu chấm không hợp lệ');
  if (base.length < 2) return [];

  const spaces = base.length - 1;
  const totalCombinations = 1n << BigInt(spaces);
  const available = totalCombinations - 1n;
  const maxRequested = count === 'all' ? Number(available > 2000n ? 2000n : available) : Math.min(Math.max(Number(count) || 1, 1), 2000);
  
  const results = [];

  if (mode === 'one_dot') {
    // Chỉ 1 dấu chấm ở các vị trí khác nhau
    for (let i = 1; i < base.length && results.length < maxRequested; i++) {
      const variant = base.slice(0, i) + '.' + base.slice(i);
      results.push(`${variant}@${targetDomain}`);
    }
    return results;
  }

  if (mode === 'two_dots') {
    // Đúng 2 dấu chấm
    for (let i = 1; i < base.length - 1 && results.length < maxRequested; i++) {
      for (let j = i + 1; j < base.length && results.length < maxRequested; j++) {
        const variant = base.slice(0, i) + '.' + base.slice(i, j) + '.' + base.slice(j);
        results.push(`${variant}@${targetDomain}`);
      }
    }
    return results;
  }

  if (mode === 'alternating') {
    // Dấu chấm xen kẽ giữa mỗi chữ cái
    const alt = base.split('').join('.');
    return [`${alt}@${targetDomain}`];
  }

  const fromMask = mask => {
    let local = base[0];
    for (let i = 1; i < base.length; i++) local += ((mask >> BigInt(i - 1)) & 1n ? '.' : '') + base[i];
    return `${local}@${targetDomain}`;
  };

  if (mode === 'random') {
    // Partial Fisher-Yates samples distinct masks uniformly without enumerating
    // the entire space (up to 2^29-1 combinations for a Gmail name).
    const population = Number(available);
    const swapped = new Map();
    for (let i = 0, limit = Math.min(maxRequested, population); i < limit; i++) {
      const index = randomInt(i, population);
      const chosen = swapped.get(index) ?? index;
      swapped.set(index, swapped.get(i) ?? i);
      results.push(fromMask(BigInt(chosen + 1)));
    }
    return results;
  }

  // Chế độ tuần tự 'all'
  for (let mask = 1n; mask < totalCombinations && results.length < maxRequested; mask++) {
    results.push(fromMask(mask));
  }

  return results;
}

export const DOT_PATTERNS = Object.freeze(['binary','random','one_dot','two_dots','alternating']);

export function generateCombinedDotVariants(email, { count = 50, useGooglemail = false } = {}) {
  const base = gmailCanonical(email).split('@')[0];
  const limit = Math.min(Math.max(Number(count) || 1, 1), 2000);
  const selected = new Set();
  const options = { useGooglemail };
  const add = address => { if (address && selected.size < limit) selected.add(address); };
  const sample = variants => variants.length ? variants[randomInt(variants.length)] : null;
  add(sample(generateDotVariants(email, { ...options, count: 2000, mode: 'one_dot' })));
  add(sample(generateDotVariants(email, { ...options, count: 2000, mode: 'two_dots' })));
  add(sample(generateDotVariants(email, { ...options, count: 1, mode: 'alternating' })));
  for (const address of generateDotVariants(email, { ...options, count: Math.min(limit + 3, 2000), mode: 'random' })) add(address);
  const variants = [...selected];
  for (let i = variants.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [variants[i], variants[j]] = [variants[j], variants[i]];
  }
  return variants.map(address => {
    const dots = address.split('@')[0].split('.').length - 1;
    const categories = ['binary','random'];
    if (dots === 1) categories.push('one_dot');
    if (dots === 2) categories.push('two_dots');
    if (base.length > 1 && dots === base.length - 1) categories.push('alternating');
    return { address, categories };
  });
}

// Giữ lại hàm tương thích ngược cho unit test
export function gmailDotVariants(value, count = 20) {
  return generateDotVariants(value, { count, mode: 'all' });
}

export function gmailPlusAlias(value, tag) {
  const canonical = gmailCanonical(value);
  const clean = String(tag || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,39}$/.test(clean)) {
    throw new InputError('Tag must be 1–40 letters, digits, dots, underscores or hyphens');
  }
  return `${canonical.split('@')[0]}+${clean}@gmail.com`;
}

/**
 * Sinh danh sách biến thể thẻ Plus (+) phong phú
 */
export function generatePlusVariants(email, { preset = 'numbers', customTag = '', count = 20, offset = 0 } = {}) {
  const base = gmailCanonical(email).split('@')[0];
  const pageSize = Number(count);
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 2000) throw new InputError('Mỗi lô Thẻ Plus phải có 1–2.000 địa chỉ');
  const offsetText = String(offset);
  if (!/^(0|[1-9]\d*)$/.test(offsetText) || offsetText.length > 100) throw new InputError('Vị trí bắt đầu không hợp lệ');
  const start = BigInt(offsetText);
  const prefix = String(customTag || '').trim().toLowerCase();
  if (prefix && !/^[a-z0-9][a-z0-9._-]*$/.test(prefix)) throw new InputError('Từ khóa Thẻ Plus không hợp lệ');
  const social = ['facebook','tiktok','instagram','twitter','telegram','discord','reddit','threads','youtube','snapchat','pinterest','linkedin','twitch','steam','roblox','epic','spotify','netflix','amazon','apple'];
  const services = ['google','openai','claude','github','gitlab','bitbucket','notion','figma','canva','binance','stripe','paypal','shopee','lazada','tiki','vps','cloudflare','digitalocean','aws','azure'];
  if (!['numbers','social','services','random_hash','date'].includes(preset)) throw new InputError('Gói Thẻ Plus không hợp lệ');
  const today = new Date().toISOString().slice(0,10).replace(/-/g,'');
  const results = [];
  for (let i = 0; i < pageSize; i++) {
    const index = start + BigInt(i);
    let tag;
    if (preset === 'numbers') tag = prefix ? `${prefix}${index + 1n}` : String(index + 1n).padStart(3,'0');
    else if (preset === 'date') tag = `${prefix ? `${prefix}_` : ''}${today}_${index + 1n}`;
    else if (preset === 'random_hash') tag = `${prefix ? `${prefix}_` : ''}r${index.toString(36)}_${randomHex(5)}`;
    else {
      const words = preset === 'social' ? social : services;
      const word = words[Number(index % BigInt(words.length))];
      const cycle = index / BigInt(words.length);
      tag = `${prefix ? `${prefix}_` : ''}${word}${cycle ? cycle + 1n : ''}`;
    }
    if (base.length + 1 + tag.length > 64) throw new InputError('Địa chỉ đã đạt giới hạn thực tế 64 ký tự của Gmail');
    results.push(`${base}+${tag}@gmail.com`);
  }
  return results;
}

export function ownedDomainAlias(domain, local) {
  const cleanDomain = String(domain || '').trim().toLowerCase();
  const cleanLocal = String(local || '').trim().toLowerCase();
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(cleanDomain)) throw new InputError('Invalid owned domain');
  if (!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(cleanLocal)) throw new InputError('Local part must be 3–40 letters, digits, dots, underscores or hyphens');
  return `${cleanLocal}@${cleanDomain}`;
}

const CONTEXT = /(?:verification|verify|verified|one[- ]time|passcode|security code|login code|otp|activation|kích hoạt|kich hoat|access code|mã truy cập|ma truy cap|mã xác (?:nhận|thực|minh)|ma xac (?:nhan|thuc|minh)|mã đăng nhập|ma dang nhap|mã của bạn|ma cua ban|mã bảo mật|ma bao mat|confirmation code|is your code|code is|code|pin)/i;

export function extractOtp(text, receivedAt = Date.now(), allowStale = false) {
  const date = typeof receivedAt === 'number' ? receivedAt : Date.parse(receivedAt);
  if (!Number.isFinite(date)) return null;
  if (!allowStale && (Date.now() - date > 15 * 60_000 || date - Date.now() > 2 * 60_000)) return null;
  const source = String(text || '').slice(0, 100_000);
  if (!CONTEXT.test(source)) return null;
  const gMatch = source.match(/\b(G-\d{6})\b/i);
  if (gMatch) return { code: gMatch[1].toUpperCase(), expiresAt: new Date(date + 15 * 60_000).toISOString(), confidence: 'high' };
  const matches = [...source.matchAll(/\b(?:\d[\s-]?){4,8}\b/g)];
  for (const match of matches) {
    const code = match[0].replace(/[\s-]/g, '');
    if (code.length < 4 || code.length > 8) continue;
    const vicinity = source.slice(Math.max(0, match.index - 90), Math.min(source.length, match.index + match[0].length + 90));
    if (CONTEXT.test(vicinity)) return { code, expiresAt: new Date(date + 15 * 60_000).toISOString(), confidence: 'candidate' };
  }
  return null;
}
