import { existsSync } from 'node:fs';
import { openDatabase, now } from '../src/db.mjs';
import { configFromEnv } from '../src/config.mjs';

if (process.argv.includes('--all') || process.argv.includes('--reset')) {
  console.error('Dùng Full Reset trong Cài đặt của ứng dụng để xác thực và sao lưu trước khi xóa dữ liệu.');
  process.exit(1);
}
const config=configFromEnv();
if (!existsSync(config.dbPath)) {
  console.log('Chưa có cơ sở dữ liệu để dọn.');
  process.exit(0);
}
const db=openDatabase(config.dbPath);
try {
  const expiredAliases=db.prepare('DELETE FROM aliases WHERE expires_at IS NOT NULL AND expires_at<?').run(now()).changes;
  const expiredSessions=db.prepare('DELETE FROM sessions WHERE expires_at<?').run(now()).changes;
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  console.log(`Đã dọn ${expiredAliases} địa chỉ hết hạn và ${expiredSessions} phiên hết hạn; đã checkpoint SQLite.`);
} finally {
  db.close();
}

