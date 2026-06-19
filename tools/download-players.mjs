// Download every player's photo from Wikipedia/Wikimedia into the app project
// folder (client/assets/img/players/<slug>.<ext>) and write a manifest mapping
// each slug to its local path. Resumable + polite (throttled, retries 429).
// Run with: node tools/download-players.mjs
import { writeFile, readFile, mkdir, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ALL } from './players.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'client', 'assets', 'img', 'players');
const manifestPath = path.join(root, 'tools', 'players-images.json');
const UA = 'FakkirTriviaGame/1.0 (educational project; educational project)';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// alternate Wikipedia titles to try when the primary has no image / 404
const TITLE_FALLBACKS = {
  xavi: ['Xavi', 'Xavi Hernández', 'Xavi Hernandez'],
  raul: ['Raúl', 'Raúl González', 'Raúl González Blanco'],
};

await mkdir(outDir, { recursive: true });

const extOf = (url) => {
  const m = /\.(jpg|jpeg|png|gif|webp)(?:$|\?)/i.exec(url);
  return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg';
};

// resume: keep whatever the manifest + folder already have
let manifest = {};
try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); } catch {}
const onDisk = new Set((await readdir(outDir).catch(() => [])).map(f => f.split('.')[0]));

// action API pageimages is the most reliable source of the lead image
async function imageUrlFor(title) {
  const api = 'https://en.wikipedia.org/w/api.php?action=query&format=json&prop=pageimages'
    + '&piprop=original%7Cthumbnail&pithumbsize=500&redirects=1&titles=' + encodeURIComponent(title);
  const res = await fetch(api, { headers: { 'User-Agent': UA, accept: 'application/json' } });
  if (!res.ok) throw new Error('api HTTP ' + res.status);
  const j = await res.json();
  const pages = j.query && j.query.pages;
  const page = pages && Object.values(pages)[0];
  if (!page) throw new Error('no page');
  return (page.thumbnail && page.thumbnail.source) || (page.original && page.original.source) || null;
}

async function resolveUrl(p) {
  const titles = TITLE_FALLBACKS[p.slug] || [p.wiki];
  for (const t of titles) {
    try { const u = await imageUrlFor(t); if (u) return u; } catch {}
    await sleep(150);
  }
  return null;
}

// fetch with retry on 429/5xx, honoring Retry-After
async function fetchRetry(url, attempts = 5) {
  let wait = 1200;
  for (let i = 0; i < attempts; i++) {
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    if (r.ok) return r;
    if (r.status === 429 || r.status >= 500) {
      const ra = Number(r.headers.get('retry-after'));
      await sleep(ra > 0 ? ra * 1000 : wait);
      wait = Math.min(wait * 2, 15000);
      continue;
    }
    throw new Error('image HTTP ' + r.status);
  }
  throw new Error('image HTTP 429 (gave up)');
}

let ok = 0, skip = 0; const fails = [];
for (const p of ALL) {
  if (manifest[p.slug] && onDisk.has(p.slug)) { skip++; continue; } // already have it
  try {
    const url = await resolveUrl(p);
    if (!url) throw new Error('no image found');
    const r = await fetchRetry(url);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 1024) throw new Error('image too small');
    const file = `${p.slug}.${extOf(url)}`;
    await writeFile(path.join(outDir, file), buf);
    manifest[p.slug] = `assets/img/players/${file}`;
    ok++;
    process.stdout.write(`✓ ${p.slug} (${(buf.length/1024|0)}KB) `);
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n'); // save progress each time
    await sleep(400); // be polite to the image CDN
  } catch (e) {
    fails.push(`${p.slug} [${p.wiki}]: ${e.message}`);
    process.stdout.write(`✗ ${p.slug} `);
  }
}
console.log('\n');
console.log(`Done. new=${ok}, already-had=${skip}, missing=${fails.length}, total=${ALL.length}.`);
if (fails.length) { console.log('\nStill missing:\n' + fails.join('\n')); process.exitCode = 1; }
