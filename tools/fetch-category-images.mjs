/**
 * fetch-category-images.mjs
 * Downloads one curated, freely-licensed real photo per category from Wikimedia
 * Commons, crops it to 1200x800 (cover), composites a subtle dark gradient + gold
 * brand bar for a cohesive premium set, and writes:
 *   client/assets/img/categories/<slug>.png
 * License/attribution for every image is recorded in:
 *   client/assets/img/categories/CREDITS.json
 *
 * Usage:
 *   node tools/fetch-category-images.mjs            # all categories
 *   node tools/fetch-category-images.mjs quran dish # only these slugs
 *
 * sharp is resolved from server/node_modules (installed there as a dev tool).
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'client', 'assets', 'img', 'categories');
// resolve sharp from the server project where it was installed
const require = createRequire(pathToFileURL(path.join(ROOT, 'server', 'index-base.cjs')));
const sharp = require('sharp');

const W = 1200, H = 800;
const UA = 'FakkirTriviaGame/1.0 (category art pipeline; contact: game maintainer)';

// slug -> ordered search terms (first that yields a good image wins).
// Terms are chosen to be descriptive AND appropriate for sensitive categories
// (e.g. mosques/calligraphy for the Islamic ones — never any figural depiction).
const TERMS = {
  geo:        ['physical world map', 'globe earth continents', 'world map atlas'],
  history:    ['Colosseum Rome', 'ancient Roman ruins', 'Pyramids of Giza'],
  palestine:  ['Dome of the Rock Jerusalem', 'Al-Aqsa Mosque Jerusalem', 'Jerusalem old city'],
  seerah:     ['Al-Masjid an-Nabawi Medina', 'Prophet Mosque Medina', 'Masjid Nabawi green dome'],
  quran:      ['open Quran mushaf', 'Holy Quran pages', 'Quran book reading'],
  flags:      ['national flags flagpoles', 'row of world flags', 'flags United Nations Geneva'],
  sports:     ['athletics stadium track', 'olympic running track', 'sports stadium crowd'],
  football:   ['football stadium pitch', 'soccer ball stadium grass', 'football match floodlights'],
  riddles:    ['hedge maze labyrinth', 'jigsaw puzzle pieces', 'wooden maze puzzle'],
  science:    ['chemistry laboratory flasks', 'science laboratory glassware', 'laboratory microscope'],
  tech:       ['circuit board macro', 'computer motherboard', 'server data center'],
  animals:    ['lion savanna', 'African safari wildlife', 'elephant savanna'],
  general:    ['old library bookshelves', 'library reading hall books', 'rows of books library'],
  math:       ['blackboard mathematical equations', 'mathematics formulas chalkboard', 'numbers chalkboard'],
  whoami:     ['neon question mark', 'mystery question mark dark', 'glowing question mark'],
  proverbs:   ['old parchment scroll', 'antique manuscript paper', 'aged parchment writing'],
  dish:       ['Arabic mezze platter', 'Middle Eastern food spread', 'mansaf arabic cuisine'],
  crime:      ['magnifying glass detective', 'fingerprint investigation', 'detective desk clues'],
  rescue:     ['Lady Justice statue bronze', 'judge gavel on desk', 'courtroom interior bench'],
  closest:    ['dartboard bullseye', 'darts target board', 'archery target'],
  capitals:   ['city skyline night', 'metropolis cityscape skyline', 'downtown skyscrapers skyline'],
  currencies: ['Euro coins', 'pile of coins money', 'gold coins stack'],
  verse:      ['Quran Arabic calligraphy', 'Islamic calligraphy art', 'Arabic calligraphy manuscript'],
  ordering:   ['wooden number blocks', 'colorful numbers blocks toy', 'abacus counting beads'],
  players:    ['association football player match', 'soccer player kicking ball', 'footballer dribbling jersey'],
};

// relevance gate: when set, a candidate file's title MUST contain one of these
// tokens. Stops loose full-text matches (e.g. a parking "stack", an F1 "podium").
const REQUIRE = {
  rescue:     ['justice', 'gavel', 'court', 'judge', 'law', 'tribunal', 'themis', 'jury'],
  currencies: ['coin', 'money', 'cash', 'banknote', 'currency', 'euro', 'dollar', 'bill', 'bullion'],
  ordering:   ['number', 'block', 'abacus', 'digit', 'counting', 'cube'],
  geo:        ['map', 'globe', 'world', 'atlas', 'earth'],
  flags:      ['flag'],
  capitals:   ['skyline', 'city', 'cityscape', 'skyscraper', 'downtown', 'panorama'],
  closest:    ['dart', 'bullseye', 'target', 'archery'],
  math:       ['math', 'equation', 'formula', 'blackboard', 'chalkboard', 'number'],
};

// slugs whose relevance gate matches the FILENAME only (descriptions too noisy)
const STRICT_TITLE = new Set(['currencies', 'ordering']);

// exact, hand-picked Commons files for slugs where search/category relevance
// is unreliable (abstract concepts). Tried first, before everything else.
const FILE = {
  dish:   'File:Kabsa (6486384335).jpg',
  crime:  'File:Aa tattonpark2010 handcuffs.jpg',
  flags:  'File:Flags of countries participated in the European Games 2019 (Minsk) — general view.jpg',
  whoami: 'File:Question mark (5230973747).jpg',
  science: 'File:Glassware.JPG',
  animals: 'File:Lion cub with mother.jpg',
};

// for stubborn slugs, pull from a curated Commons CATEGORY (guaranteed on-topic)
// instead of fuzzy full-text search. Tried before the term search.
const CATEGORY = {
  currencies: ['Category:Stacks of coins', 'Category:Coins on white background', 'Category:Banknotes of the euro'],
  ordering:   ['Category:Abacuses', 'Category:Soroban', 'Category:Counting frames'],
  seerah:     ['Category:Al-Masjid an-Nabawi'],
  players:    ["Category:Men's association football"],
  whoami:     ['Category:Question marks'],
  crime:      ['Category:Magnifying glasses'],
  dish:       ['Category:Arab cuisine'],
  flags:      ['Category:Groups of flags', 'Category:Flagpoles'],
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// fetch with retry/backoff that honors Retry-After on 429/5xx (Commons rate-limits bursts)
async function fetchRetry(url, tries = 6) {
  let wait = 1200;
  for (let i = 0; i < tries; i++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (res.ok) return res;
    if (res.status === 429 || res.status >= 500) {
      const ra = Number(res.headers.get('retry-after'));
      const delay = Number.isFinite(ra) && ra > 0 ? ra * 1000 : wait;
      await sleep(delay);
      wait = Math.min(wait * 2, 15000);
      continue;
    }
    throw new Error('HTTP ' + res.status);
  }
  throw new Error('HTTP 429 (gave up after retries)');
}

// shape + relevance filter shared by the search and category paths
function pickCandidates(pages, slug, { skipRequire = false } = {}) {
  return pages
    .map(p => ({ title: p.title, info: p.imageinfo?.[0] }))
    .filter(x => x.info && /image\/(jpeg|png)/.test(x.info.mime))
    .filter(x => x.info.width >= 1000 && x.info.height >= 650)
    .filter(x => { const r = x.info.width / x.info.height; return r >= 0.9 && r <= 2.6; })
    .filter(x => !/\.svg/i.test(x.title))
    // prefer real photos (JPEG) over PNGs, which are more often clipart/diagrams
    .sort((a, b) => (b.info.mime === 'image/jpeg') - (a.info.mime === 'image/jpeg'))
    .filter(x => {
      const req = REQUIRE[slug];
      if (skipRequire || !req) return true;
      const em = x.info.extmetadata || {};
      // some slugs are noisy in descriptions (a coin shown "for scale", an F1
      // "podium"), so match their filename only; others may use richer metadata.
      const sources = STRICT_TITLE.has(slug)
        ? [x.title]
        : [x.title, em.ImageDescription?.value, em.ObjectName?.value, em.Categories?.value];
      const hay = sources.join(' ').replace(/<[^>]*>/g, ' ').toLowerCase();
      return req.some(k => hay.includes(k));
    });
}

async function searchCommons(term, slug) {
  const url = 'https://commons.wikimedia.org/w/api.php?' + new URLSearchParams({
    action: 'query', format: 'json', generator: 'search',
    gsrsearch: `${term} filetype:bitmap`, gsrnamespace: '6', gsrlimit: '15',
    prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata', iiurlwidth: '1600'
  });
  const res = await fetchRetry(url);
  const json = await res.json();
  const pages = json?.query?.pages ? Object.values(json.query.pages) : [];
  return pickCandidates(pages, slug);
}

// pull file members of a curated Commons category (guaranteed on-topic)
async function categoryImages(catTitle, slug) {
  const url = 'https://commons.wikimedia.org/w/api.php?' + new URLSearchParams({
    action: 'query', format: 'json', generator: 'categorymembers',
    gcmtitle: catTitle, gcmtype: 'file', gcmlimit: '40',
    prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata', iiurlwidth: '1600'
  });
  const res = await fetchRetry(url);
  const json = await res.json();
  const pages = json?.query?.pages ? Object.values(json.query.pages) : [];
  // category membership already guarantees the topic, so skip the keyword gate
  return pickCandidates(pages, slug, { skipRequire: true });
}

// the cohesive brand overlay: light top, darker bottom, soft vignette, gold bar
const OVERLAY = Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#0a1626" stop-opacity="0.12"/>
      <stop offset="50%" stop-color="#0a1626" stop-opacity="0.04"/>
      <stop offset="100%" stop-color="#060d16" stop-opacity="0.68"/>
    </linearGradient>
    <radialGradient id="v" cx="50%" cy="42%" r="78%">
      <stop offset="58%" stop-color="#000000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#060d16" stop-opacity="0.5"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#g)"/>
  <rect width="${W}" height="${H}" fill="url(#v)"/>
  <rect x="0" y="${H - 12}" width="${W}" height="12" fill="#d7a018"/>
</svg>`);

async function processImage(buf, slug) {
  const out = path.join(OUT_DIR, slug + '.png');
  await sharp(buf)
    .resize(W, H, { fit: 'cover', position: sharp.strategy.attention })
    .composite([{ input: OVERLAY }])
    .png({ quality: 90, compressionLevel: 9 })
    .toFile(out);
  return out;
}

// download + process the first candidate that yields a real photo; returns meta or null
async function tryCandidates(cands, slug, via) {
  for (const c of cands.slice(0, 6)) {
    const src = c.info.thumburl || c.info.url;
    try {
      const r = await fetchRetry(src);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 8000) continue; // too small to be a real photo
      await processImage(buf, slug);
      const em = c.info.extmetadata || {};
      const strip = s => (s ? String(s).replace(/<[^>]*>/g, '').trim() : '');
      return {
        slug, via, file: c.title,
        source: c.info.descriptionurl || c.info.url,
        artist: strip(em.Artist?.value) || 'Unknown',
        license: strip(em.LicenseShortName?.value) || strip(em.License?.value) || 'see source'
      };
    } catch { /* try next candidate */ }
  }
  return null;
}

// fetch imageinfo for one exact File: title
async function fileInfo(title) {
  const url = 'https://commons.wikimedia.org/w/api.php?' + new URLSearchParams({
    action: 'query', format: 'json', titles: title,
    prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata', iiurlwidth: '1600'
  });
  const res = await fetchRetry(url);
  const json = await res.json();
  const pages = json?.query?.pages ? Object.values(json.query.pages) : [];
  return pickCandidates(pages, null, { skipRequire: true });
}

async function fetchOne(slug) {
  let lastErr;
  // 0) exact hand-picked file (highest priority)
  if (FILE[slug]) {
    try {
      const meta = await tryCandidates(await fileInfo(FILE[slug]), slug, FILE[slug]);
      if (meta) return meta;
    } catch (e) { lastErr = e; }
  }
  // 1) curated category first (most reliable relevance) for stubborn slugs
  for (const cat of (CATEGORY[slug] || [])) {
    try {
      const meta = await tryCandidates(await categoryImages(cat, slug), slug, cat);
      if (meta) return meta;
    } catch (e) { lastErr = e; }
    await sleep(700);
  }
  // 2) fall back to keyword search with the relevance gate
  const terms = TERMS[slug];
  if (!terms) throw new Error('no search terms for ' + slug);
  for (const term of terms) {
    try {
      const meta = await tryCandidates(await searchCommons(term, slug), slug, term);
      if (meta) return meta;
    } catch (e) { lastErr = e; }
    await sleep(700); // be polite to the API between term searches
  }
  throw lastErr || new Error('no usable image for ' + slug);
}

async function main() {
  const only = process.argv.slice(2);
  const slugs = only.length ? only : Object.keys(TERMS);
  await fs.mkdir(OUT_DIR, { recursive: true });

  // merge into existing credits so partial runs don't lose attribution
  let credits = {};
  try { credits = JSON.parse(await fs.readFile(path.join(OUT_DIR, 'CREDITS.json'), 'utf8')); } catch {}

  const ok = [], failed = [];
  for (const slug of slugs) {
    process.stdout.write(`• ${slug.padEnd(12)} `);
    try {
      const meta = await fetchOne(slug);
      credits[slug] = meta;
      ok.push(slug);
      console.log(`✓  ${meta.file}  [${meta.license}]`);
    } catch (e) {
      failed.push(slug);
      console.log(`✗  ${e.message}`);
    }
    await sleep(1100); // pace between categories to stay under rate limits
  }

  await fs.writeFile(path.join(OUT_DIR, 'CREDITS.json'), JSON.stringify(credits, null, 2) + '\n');
  console.log(`\nDone. ${ok.length} ok, ${failed.length} failed.` + (failed.length ? ' Failed: ' + failed.join(', ') : ''));
  if (failed.length) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exit(1); });
