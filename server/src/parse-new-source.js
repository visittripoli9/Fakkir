/**
 * parse-new-source.js
 * Parses data/new-questions.txt (category-first layout) into data/fakkir-data.json.
 *
 * Layout of the source:
 *   - 22 category sections, each headed by a line like "جغرافيا (1" ... "الترتيب الصحيح (22".
 *   - Each section has 3 difficulty levels marked by a line containing "المستوى"
 *     (السهل/المتوسط/الصعب). The three levels map to point values 200 / 400 / 600.
 *   - Each level holds 30 questions, so each category has 90 -> laid out as 15 versions
 *     of 6 questions (2×200, 2×400, 2×600), exactly like the previous data model.
 *   - Question/answer encoding differs per category (see SECTIONS[].fmt below):
 *       A  "N. **Q؟**" then a following "* الجواب: A." line          (geo)
 *       B  "N. Q؟ A."  answer inline after the last ؟               (history, sports, math, ...)
 *       C  "N. Q؟ (A)" answer is the last parenthesised group       (riddles, animals, dish, capitals, ...)
 *       D  "N. Q؟ الجواب: A."                                       (closest)
 *       E  "N. <مثل>... <تكملة>."                                   (proverbs)
 *       F  'N. "<آية>... <كلمة>" (السورة)'                          (verse)
 *       G  "N. عنوان: (عناصر) -> ترتيب"                             (ordering)
 *       FLAGS  "N. اسم الدولة"  -> real flag images                 (flags)
 *
 * The two scenario categories (crime / rescue) are NOT in this file; their questions and
 * the categories list are preserved from the existing data/fakkir-data.json.
 *
 * Usage:  node src/parse-new-source.js
 */
const fs = require('fs');
const path = require('path');

const srcPath = path.join(__dirname, '../../data/new-questions.txt');
const outPath = path.join(__dirname, '../../data/fakkir-data.json');

const TIER_VALUES = [200, 400, 600];
const warnings = [];

// Section number (in the source) -> slug + format.
const SECTIONS = [
  { n: 1, slug: 'geo', fmt: 'A' },
  { n: 2, slug: 'football', fmt: 'B' },
  { n: 3, slug: 'history', fmt: 'B' },
  { n: 4, slug: 'palestine', fmt: 'B' },
  { n: 5, slug: 'seerah', fmt: 'B' },
  { n: 6, slug: 'quran', fmt: 'B' },
  { n: 7, slug: 'flags', fmt: 'FLAGS' },
  { n: 8, slug: 'sports', fmt: 'B' },
  { n: 9, slug: 'riddles', fmt: 'C' },
  { n: 10, slug: 'science', fmt: 'B' },
  { n: 11, slug: 'tech', fmt: 'B' },
  { n: 12, slug: 'animals', fmt: 'C' },
  { n: 13, slug: 'general', fmt: 'B' },
  { n: 14, slug: 'math', fmt: 'B' },
  { n: 15, slug: 'whoami', fmt: 'C' },
  { n: 16, slug: 'proverbs', fmt: 'E' },
  { n: 17, slug: 'dish', fmt: 'C' },
  { n: 18, slug: 'closest', fmt: 'D' },
  { n: 19, slug: 'capitals', fmt: 'C' },
  { n: 20, slug: 'currencies', fmt: 'C' },
  { n: 21, slug: 'verse', fmt: 'F' },
  { n: 22, slug: 'ordering', fmt: 'G' }
];

// Arabic country name -> ISO 3166-1 alpha-2 (for flagcdn images), for the flags category.
const FLAG_ISO = {
  'السعودية': 'sa', 'مصر': 'eg', 'الإمارات': 'ae', 'فلسطين': 'ps', 'لبنان': 'lb',
  'المغرب': 'ma', 'قطر': 'qa', 'الكويت': 'kw', 'الجزائر': 'dz', 'تونس': 'tn',
  'الولايات المتحدة': 'us', 'بريطانيا': 'gb', 'فرنسا': 'fr', 'ألمانيا': 'de', 'إيطاليا': 'it',
  'إسبانيا': 'es', 'البرازيل': 'br', 'الأرجنتين': 'ar', 'اليابان': 'jp', 'الصين': 'cn',
  'كندا': 'ca', 'تركيا': 'tr', 'روسيا': 'ru', 'الهند': 'in', 'أستراليا': 'au',
  'المكسيك': 'mx', 'هولندا': 'nl', 'البرتغال': 'pt', 'اليونان': 'gr', 'سويسرا': 'ch',
  'جنوب أفريقيا': 'za', 'كوريا الجنوبية': 'kr', 'بلجيكا': 'be', 'السويد': 'se', 'النرويج': 'no',
  'النمسا': 'at', 'الدنمارك': 'dk', 'بولندا': 'pl', 'التشيك': 'cz', 'المجر': 'hu',
  'كولومبيا': 'co', 'تشيلي': 'cl', 'فيتنام': 'vn', 'ماليزيا': 'my', 'إندونيسيا': 'id',
  'سنغافورة': 'sg', 'تايلاند': 'th', 'الفلبين': 'ph', 'إيران': 'ir', 'العراق': 'iq',
  'الأردن': 'jo', 'سلطنة عمان': 'om', 'اليمن': 'ye', 'ليبيا': 'ly', 'السودان': 'sd',
  'موريتانيا': 'mr', 'نيجيريا': 'ng', 'كينيا': 'ke', 'غانا': 'gh', 'بوتان': 'bt',
  'نيبال': 'np', 'كازاخستان': 'kz', 'أوزبكستان': 'uz', 'قرغيزستان': 'kg', 'طاجيكستان': 'tj',
  'تركمانستان': 'tm', 'أذربيجان': 'az', 'جورجيا': 'ge', 'أرمينيا': 'am', 'إستونيا': 'ee',
  'لاتفيا': 'lv', 'ليتوانيا': 'lt', 'فنلندا': 'fi', 'أيسلندا': 'is', 'أيرلندا': 'ie',
  'كرواتيا': 'hr', 'صربيا': 'rs', 'سلوفينيا': 'si', 'سلوفاكيا': 'sk', 'بلغاريا': 'bg',
  'رومانيا': 'ro', 'مولدوفا': 'md', 'بيلاروسيا': 'by', 'أوكرانيا': 'ua', 'مدغشقر': 'mg',
  'موريشيوس': 'mu', 'سيشل': 'sc', 'جامايكا': 'jm', 'باراغواي': 'py'
};

// --- helpers ---------------------------------------------------------------

const stripItem = (s) =>
  String(s).replace(/^\s*[#>*\s]*\d+\s*[.)．]\s*/, '').replace(/\*\*/g, '').trim();

function cleanAnswer(a) {
  let s = String(a).trim().replace(/\*\*/g, '');
  // "x - لا، الإجابة: y" / "لا يوجد، الإجابة: y" -> keep the corrected answer after الإجابة:
  const fix = s.match(/الإجابة\s*[:：]\s*([^)]*)\)?\s*$/);
  if (fix) s = fix[1];
  s = s.trim()
    .replace(/^[«"“”]+/, '').replace(/[»"“”]+$/g, '')
    .replace(/[\s.．؟?:،\-–—]+$/g, '').trim(); // trailing sentence punctuation (NOT closing parens)
  // unwrap an answer that is fully enclosed in one matched () pair, e.g. "(قيل في الغدر)"
  if (s.startsWith('(')) {
    const g = parenGroups(s);
    if (g.length === 1 && g[0].start === 0 && g[0].end === s.length - 1) {
      s = g[0].text.trim().replace(/[\s.．؟?:،]+$/g, '').trim();
    }
  }
  return s;
}

const isLevelHeader = (l) =>
  /المستوى/.test(l) &&
  /(السهل|المتوسط|الصعب|الأول|الثاني|الثالث|سهل|متوسط|صعب|أولاً|ثانيا|ثالثا)/.test(l) &&
  !/^\s*\d/.test(l);

const headerNumber = (l) => {
  const m = l.trim().match(/^(.+?)\s*\(\s*(\d{1,2})\s*$/);
  if (m) { const n = +m[2]; if (n >= 1 && n <= 22) return n; }
  return null;
};

// Top-level parenthesised groups (depth aware).
function parenGroups(s) {
  const groups = [];
  let depth = 0, start = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(' || ch === '（') { if (depth === 0) start = i; depth++; }
    else if (ch === ')' || ch === '）') {
      depth--;
      if (depth === 0 && start >= 0) { groups.push({ text: s.slice(start + 1, i), start, end: i }); start = -1; }
      if (depth < 0) depth = 0;
    }
  }
  return groups;
}

// --- per-format question parsers (return {q,a,...} or null) ----------------

function parseB(line) {
  const s = stripItem(line);
  let idx = -1;
  for (let i = 0; i < s.length; i++) if (s[i] === '؟' || s[i] === '?') idx = i;
  if (idx < 0) return null;
  const q = s.slice(0, idx + 1).trim().replace(/\?$/, '؟'); // normalise trailing ASCII ?
  const a = cleanAnswer(s.slice(idx + 1));
  if (!q || !a) return null;
  return { q, a };
}

function parseC(line) {
  const s = stripItem(line);
  const groups = parenGroups(s);
  if (!groups.length) return null;
  const ans = groups[groups.length - 1];
  const a = cleanAnswer(ans.text);
  const q = s.slice(0, ans.start).trim();
  if (!q || !a) return null;
  return { q, a };
}

function parseD(line) {
  const s = stripItem(line);
  const m = s.match(/^(.*?)\s*الجواب\s*[:：]\s*(.+)$/);
  if (!m) return null;
  const q = m[1].trim();
  const a = cleanAnswer(m[2]);
  if (!q || !a) return null;
  return { q, a };
}

function parseE(line) {
  const s = stripItem(line);
  const m = s.match(/^(.*?(?:\.{2,}|…))\s*(.+)$/); // split at the LAST run of dots is below
  if (!m) return null;
  // split at the LAST dot-run so multi-dot prompts keep their interior dots
  const re = /(\.{2,}|…)/g;
  let last = -1, mm;
  while ((mm = re.exec(s))) last = mm.index + mm[0].length;
  if (last < 0) return null;
  const prompt = s.slice(0, last).replace(/[\s.．…]+$/g, '').trim();
  let a = cleanAnswer(s.slice(last));
  if (!prompt || !a) return null;
  return { q: `"${prompt}..."؟`, a };
}

function parseF(line) {
  const s = stripItem(line);
  const qmatch = s.match(/"([^"]*)"/);
  if (!qmatch) return null;
  const inner = qmatch[1];
  const surahM = s.slice(qmatch.index + qmatch[0].length).match(/\(([^)]*)\)/);
  const surah = surahM ? surahM[1].trim() : '';
  const re = /(\.{2,}|…)/g;
  let last = -1, mm;
  while ((mm = re.exec(inner))) last = mm.index + mm[0].length;
  if (last < 0) return null;
  const prefix = inner.slice(0, last).replace(/[\s.．…]+$/g, '').trim();
  const a = cleanAnswer(inner.slice(last));
  if (!prefix || !a) return null;
  const row = { q: `"${prefix}..."؟`, a };
  if (surah) row.note = `سورة ${surah}`;
  return row;
}

function parseG(line) {
  const s = stripItem(line);
  const parts = s.split('->');
  if (parts.length < 2) return null;
  const left = parts[0];
  const a = parts.slice(1).join('->').trim().replace(/[.．]+$/g, '').trim();
  const colon = left.indexOf(':') >= 0 ? left.indexOf(':') : left.indexOf('：');
  const label = (colon >= 0 ? left.slice(0, colon) : left).trim();
  const groups = parenGroups(left);
  const inside = groups.length ? groups[groups.length - 1].text : '';
  const clues = inside.split(/[،,=<]/).map((x) => x.trim()).filter(Boolean);
  if (!label || !a || clues.length < 2) return null;
  return { q: `رتب من الأصغر إلى الأكبر: ${label}؟`, a, clues };
}

// --- read & segment --------------------------------------------------------

const raw = fs.readFileSync(srcPath, 'utf8').replace(/^﻿/, '');
const lines = raw.split(/\r?\n/).map((l) => l.replace(/\s+$/,'')); // keep leading spaces irrelevant; trim trailing

// locate section headers
const headers = [];
lines.forEach((l, i) => { const n = headerNumber(l); if (n) headers.push({ n, i }); });
headers.push({ n: 99, i: lines.length });

const bySlug = {}; // slug -> {easy:[],med:[],hard:[]}
for (let h = 0; h < headers.length - 1; h++) {
  const { n, i } = headers[h];
  const end = headers[h + 1].i;
  const sec = SECTIONS.find((x) => x.n === n);
  if (!sec) continue;
  const body = lines.slice(i + 1, end);

  // split body into 3 levels by the level-header lines
  const levelStarts = [];
  body.forEach((l, k) => { if (isLevelHeader(l)) levelStarts.push(k); });
  if (levelStarts.length < 3) warnings.push(`${sec.slug}: found ${levelStarts.length} level headers (expected 3)`);
  const levels = [];
  for (let t = 0; t < 3; t++) {
    const a = levelStarts[t] != null ? levelStarts[t] + 1 : body.length;
    const b = levelStarts[t + 1] != null ? levelStarts[t + 1] : body.length;
    levels.push(body.slice(a, b).filter((l) => l.trim() !== ''));
  }
  bySlug[sec.slug] = { sec, levels };
}

// --- parse each section's levels into question lists -----------------------

function looksLikeItem(fmt, l) {
  if (/^\s*\d+\s*[.)．]/.test(l)) return true;
  const s = l.trim();
  switch (fmt) {
    case 'B': { const i = Math.max(s.lastIndexOf('؟'), s.lastIndexOf('?')); return i >= 0 && s.slice(i + 1).trim().length > 0; }
    case 'C': return /\)\s*$/.test(s) && s.includes('(');
    case 'D': return /الجواب\s*[:：]/.test(s);
    case 'E': return /(\.{2,}|…)/.test(s);
    case 'F': return s.includes('"') && s.includes('(');
    case 'G': return s.includes('->');
    case 'FLAGS': return false; // flags items always carry a number
    default: return false;
  }
}

const PARSERS = { B: parseB, C: parseC, D: parseD, E: parseE, F: parseF, G: parseG };

// returns array of 30 parsed rows (or whatever it found, with warnings)
function parseLevel(slug, fmt, levelLines, valueLabel) {
  const rows = [];
  if (fmt === 'A') {
    let pending = null;
    for (const l of levelLines) {
      if (/الجواب\s*[:：]/.test(l)) {
        const a = cleanAnswer(l.replace(/^.*?الجواب\s*[:：]\s*/, ''));
        if (pending && a) rows.push({ q: pending, a });
        else warnings.push(`${slug} ${valueLabel}: answer without question -> ${l.slice(0, 40)}`);
        pending = null;
      } else {
        const q = stripItem(l);
        if (q) { if (pending) warnings.push(`${slug} ${valueLabel}: question without answer -> ${pending.slice(0, 40)}`); pending = q; }
      }
    }
    return rows;
  }
  if (fmt === 'FLAGS') {
    for (const l of levelLines) {
      let name = stripItem(l).replace(/\([^)]*\)/g, '').trim(); // drop annotations like (العلم غير المستطيل)
      if (!name) continue;
      const code = FLAG_ISO[name];
      if (!code) { warnings.push(`flags: no ISO code for "${name}"`); continue; }
      rows.push({ flag: code, a: name });
    }
    return rows;
  }
  const parse = PARSERS[fmt];
  for (const l of levelLines) {
    if (!looksLikeItem(fmt, l)) continue; // skip commentary lines
    const r = parse(l);
    if (r) rows.push(r);
    else warnings.push(`${slug} ${valueLabel}: unparseable -> ${l.slice(0, 60)}`);
  }
  return rows;
}

// --- build questions array, preserving crime/rescue from existing JSON -----

const existing = JSON.parse(fs.readFileSync(outPath, 'utf8'));

const questions = [];
const flagsMap = {};

for (const sec of SECTIONS) {
  const entry = bySlug[sec.slug];
  if (!entry) { warnings.push(`${sec.slug}: section not found`); continue; }
  const tiers = ['سهل', 'متوسط', 'صعب'].map((lbl, t) => parseLevel(sec.slug, sec.fmt, entry.levels[t], lbl));
  tiers.forEach((rows, t) => { if (rows.length !== 30) warnings.push(`${sec.slug} level${t + 1}: ${rows.length} items (expected 30)`); });

  // 15 versions × (2 easy, 2 med, 2 hard)
  for (let v = 0; v < 15; v++) {
    const slots = [
      { value: 200, row: tiers[0][2 * v] }, { value: 200, row: tiers[0][2 * v + 1] },
      { value: 400, row: tiers[1][2 * v] }, { value: 400, row: tiers[1][2 * v + 1] },
      { value: 600, row: tiers[2][2 * v] }, { value: 600, row: tiers[2][2 * v + 1] }
    ];
    slots.forEach((slot, ord) => {
      const r = slot.row;
      if (!r) { warnings.push(`${sec.slug} v${v + 1} ord${ord}: missing question`); return; }
      if (sec.fmt === 'FLAGS') {
        flagsMap[r.flag] = `https://flagcdn.com/w320/${r.flag}.png`;
        questions.push({ category: 'flags', version: v + 1, ord, value: slot.value, type: 'flag', flag: r.flag, a: r.a, q: '' });
      } else {
        questions.push({
          category: sec.slug, version: v + 1, ord, value: slot.value, type: 'normal',
          q: r.q, a: r.a,
          ...(r.clues ? { clues: r.clues } : {}),
          ...(r.note ? { note: r.note } : {})
        });
      }
    });
  }
}

// preserve scenario categories untouched
const preserved = existing.questions.filter((q) => q.category === 'crime' || q.category === 'rescue');
questions.push(...preserved);

const out = { categories: existing.categories, flags: flagsMap, questions };
fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');

// --- report ----------------------------------------------------------------

const perCat = {};
for (const q of questions) {
  perCat[q.category] = perCat[q.category] || { n: 0, v: new Set(), val: {} };
  perCat[q.category].n++;
  perCat[q.category].v.add(q.version);
  perCat[q.category].val[q.value] = (perCat[q.category].val[q.value] || 0) + 1;
}
console.log(`Total questions: ${questions.length}  |  flags: ${Object.keys(flagsMap).length}  |  categories: ${out.categories.length}`);
console.log('Per category (n / versions / values):');
for (const c of out.categories) {
  const p = perCat[c.slug];
  if (!p) { console.log(`  ${c.slug}: MISSING`); continue; }
  console.log(`  ${c.slug.padEnd(11)} n=${p.n} versions=${p.v.size} values=${JSON.stringify(p.val)}`);
}
console.log(`\nWarnings (${warnings.length}):`);
warnings.slice(0, 120).forEach((w) => console.log('  - ' + w));
if (warnings.length > 120) console.log(`  ... and ${warnings.length - 120} more`);
