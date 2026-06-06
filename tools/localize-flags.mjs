// Rewrite the flags map in the active data files so every flag points to a
// local file in the app project folder instead of the remote flagcdn URL.
// Surgical raw-text replace: "https://flagcdn.com/w320/XX.png" -> "assets/img/flags/XX.png".
// (Questions reference flags by 2-letter code, not by URL, so this only touches the flags map.)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flagsDir = path.join(root, 'client', 'assets', 'img', 'flags');
const targets = [
  path.join(root, 'client', 'assets', 'data.json'),
  path.join(root, 'data', 'fakkir-data.json'),
];

for (const file of targets) {
  let text = readFileSync(file, 'utf8');
  const before = (text.match(/flagcdn\.com/g) || []).length;
  text = text.replace(/https:\/\/flagcdn\.com\/w320\//g, 'assets/img/flags/');
  const after = (text.match(/flagcdn\.com/g) || []).length;
  writeFileSync(file, text);

  // verify the result parses and every flag file actually exists on disk
  const data = JSON.parse(text);
  const missing = Object.keys(data.flags || {}).filter(c => !existsSync(path.join(flagsDir, `${c}.png`)));
  console.log(`${path.basename(file)}: rewrote ${before - after} urls, ${after} remote refs left` +
    (missing.length ? ` | MISSING FILES: ${missing.join(', ')}` : ' | all flag files present'));
}
