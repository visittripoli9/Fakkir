// One-off: download every flag referenced by the dataset into the app project
// folder (client/assets/img/flags/<code>.png) so flags are served locally and
// never depend on a remote CDN (which the server CSP blocks anyway).
import { readFileSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'client', 'assets', 'img', 'flags');
const data = JSON.parse(readFileSync(path.join(root, 'client', 'assets', 'data.json'), 'utf8'));
const codes = Object.keys(data.flags || {}).sort();

await mkdir(outDir, { recursive: true });
console.log(`Downloading ${codes.length} flags -> ${outDir}`);

let ok = 0, fail = [];
for (const code of codes) {
  const url = `https://flagcdn.com/w320/${code}.png`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    // sanity: must be a real PNG (89 50 4E 47)
    if (buf.length < 8 || buf[0] !== 0x89 || buf[1] !== 0x50) throw new Error('not a PNG');
    await writeFile(path.join(outDir, `${code}.png`), buf);
    ok++;
  } catch (e) {
    fail.push(`${code}: ${e.message}`);
  }
}
console.log(`Done. ${ok} ok, ${fail.length} failed.`);
if (fail.length) { console.log('Failures:\n' + fail.join('\n')); process.exit(1); }
