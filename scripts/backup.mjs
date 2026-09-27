import { backup, DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadEnv } from '../src/config.mjs';
loadEnv();
if (process.platform !== 'win32') process.umask(0o077);
const dataDir=resolve(process.env.DATA_DIR || './data');
const source=join(dataDir,'workspace.sqlite');
if (!existsSync(source)) {console.error('No database to back up.');process.exit(1);}
if (process.platform !== 'win32' && ((statSync(dataDir).mode & 0o077) || (statSync(source).mode & 0o077))) throw new Error('DATA_DIR and database must be owner-only before backup');
const directory=join(dataDir,'backups');mkdirSync(directory,{recursive:true,mode:0o700});
if (process.platform !== 'win32' && (statSync(directory).mode & 0o077)) throw new Error('Backup directory must be owner-only (chmod 700)');
const target=join(directory,`workspace-${new Date().toISOString().replaceAll(':','-')}.sqlite`);
const db=new DatabaseSync(source);
try {await backup(db,target);if (process.platform !== 'win32' && (statSync(target).mode & 0o077)) throw new Error('Backup file permissions are too broad');console.log(`Database backup saved: ${target}`);}
finally {db.close();}
console.log('Keep the matching DATA_ENCRYPTION_KEY separately in a secure secret store. The backup cannot decrypt messages without it.');
