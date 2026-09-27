import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, sep } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = join(root, 'dist', 'pages');
if (!destination.startsWith(root + sep) || destination !== resolve(root, 'dist', 'pages')) {
  throw new Error('Refusing to replace an unexpected Pages build directory');
}
rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });
for (const name of ['index.html', 'style.css', 'app.js', 'manifest.webmanifest', 'sw.js']) {
  cpSync(join(root, 'pages', name), join(destination, name));
}
cpSync(join(root, 'src', 'domain.mjs'), join(destination, 'domain.mjs'));
for (const name of ['icon.svg', 'icon-192.png', 'icon-512.png']) {
  cpSync(join(root, 'public', name), join(destination, name));
}
console.log(`GitHub Pages artifact built at ${destination}`);
