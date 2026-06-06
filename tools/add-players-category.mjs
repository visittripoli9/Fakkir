// Build the "احزر اللاعب" (Guess the Player) category from tools/players.mjs +
// the downloaded image manifest, and inject it into both data files.
// Idempotent: removes any prior "players" category/questions before re-adding.
// 15 versions x 6 questions; per version: 2x200 (tier200), 2x400 (tier400), 2x600 (tier600).
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { tier200, tier400, tier600 } from './players.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(root, 'tools', 'players-images.json'), 'utf8'));

const SLUG = 'players';
const CATEGORY = { slug: SLUG, name: 'احزر اللاعب', color: 'cyan', image: 'assets/img/categories/players.png' };
const VERSIONS = 15;

function imgFor(p) {
  const img = manifest[p.slug];
  if (!img) throw new Error('missing image for ' + p.slug);
  return img;
}

// build a single question object
function makeQ(p, version, ord, value) {
  return {
    category: SLUG, version, ord, value, type: 'normal',
    q: `${p.clue} من هذا اللاعب؟`,
    a: p.ar,
    image: imgFor(p),
  };
}

const questions = [];
for (let v = 1; v <= VERSIONS; v++) {
  const i = (v - 1) * 2;
  questions.push(makeQ(tier200[i], v, 0, 200));
  questions.push(makeQ(tier200[i + 1], v, 1, 200));
  questions.push(makeQ(tier400[i], v, 2, 400));
  questions.push(makeQ(tier400[i + 1], v, 3, 400));
  questions.push(makeQ(tier600[i], v, 4, 600));
  questions.push(makeQ(tier600[i + 1], v, 5, 600));
}

// sanity: difficulty must be strictly tiered per version (200 < 400 < 600)
for (let v = 1; v <= VERSIONS; v++) {
  const vals = questions.filter(q => q.version === v).sort((a, b) => a.ord - b.ord).map(q => q.value);
  const expect = [200, 200, 400, 400, 600, 600].join(',');
  if (vals.join(',') !== expect) throw new Error(`version ${v} value layout ${vals} != ${expect}`);
}

const targets = [
  path.join(root, 'data', 'fakkir-data.json'),
  path.join(root, 'client', 'assets', 'data.json'),
];

for (const file of targets) {
  const data = JSON.parse(await readFile(file, 'utf8'));
  // idempotent: drop any existing players data first
  data.categories = data.categories.filter(c => c.slug !== SLUG);
  data.questions = data.questions.filter(q => q.category !== SLUG);
  // append fresh
  data.categories.push(CATEGORY);
  data.questions.push(...questions.map(q => ({ ...q })));
  await writeFile(file, JSON.stringify(data, null, 2) + '\n');
  console.log(`${path.basename(file)}: categories=${data.categories.length}, players questions=${questions.length}`);
}

console.log(`Done. Added category "${CATEGORY.name}" with ${questions.length} questions across ${VERSIONS} versions.`);
