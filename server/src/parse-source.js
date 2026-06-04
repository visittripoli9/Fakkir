/**
 * parse-source.js
 * Parses data/source-questions.txt (plain text extracted from the A-O Word doc)
 * into data/fakkir-data.json, replacing the previous content.
 *
 * Layout of the source:
 *   - 15 versions: an implicit first block (A) then headers "Version B" / "الإصدار C" ... "الإصدار O".
 *   - Each version has 24 numbered categories (number may be at the start "1. الجغرافيا"
 *     or at the end "... .14").
 *   - Each category has 3 point tiers (200 / 400 / 600), each normally holding two
 *     "سؤال؟ (جواب)" pairs separated by " | ".
 *   - Category 24 (الترتيب الصحيح) holds "رتب ... (عناصر) ... (الترتيب الصحيح)" units.
 *   - Categories 18/19 (الجريمة / إنقاذ المتهم) carry a shared story plus (س1)/(س2) pairs.
 *
 * Usage:  node src/parse-source.js
 */
const fs = require('fs');
const path = require('path');

const srcPath = path.join(__dirname, '../../data/source-questions.txt');
const outPath = path.join(__dirname, '../../data/fakkir-data.json');

const CATEGORY_ORDER = [
  { slug: 'geo', name: 'الجغرافيا', color: 'blue' },
  { slug: 'history', name: 'التاريخ', color: 'gold' },
  { slug: 'palestine', name: 'فلسطين', color: 'green' },
  { slug: 'seerah', name: 'السيرة النبوية', color: 'teal' },
  { slug: 'quran', name: 'القرآن الكريم', color: 'green' },
  { slug: 'flags', name: 'أعلام الدول', color: 'red' },
  { slug: 'sports', name: 'الرياضة', color: 'cyan' },
  { slug: 'football', name: 'كرة القدم', color: 'blue' },
  { slug: 'riddles', name: 'الألغاز', color: 'purple' },
  { slug: 'science', name: 'العلوم', color: 'teal' },
  { slug: 'tech', name: 'التكنولوجيا', color: 'cyan' },
  { slug: 'animals', name: 'عالم الحيوان', color: 'gold' },
  { slug: 'general', name: 'المعلومات العامة', color: 'gold' },
  { slug: 'math', name: 'الرياضيات والأرقام', color: 'blue' },
  { slug: 'whoami', name: 'احزر ماذا أنا', color: 'purple' },
  { slug: 'proverbs', name: 'تكملة المثل', color: 'teal' },
  { slug: 'dish', name: 'ما هي الأكلة', color: 'red' },
  { slug: 'crime', name: 'الجريمة', color: 'red' },
  { slug: 'rescue', name: 'إنقاذ المتهم', color: 'green' },
  { slug: 'closest', name: 'الأقرب إلى الرقم', color: 'purple' },
  { slug: 'capitals', name: 'عواصم الدول', color: 'blue' },
  { slug: 'currencies', name: 'عملات الدول', color: 'gold' },
  { slug: 'verse', name: 'أكمل الآية', color: 'green' },
  { slug: 'ordering', name: 'الترتيب الصحيح', color: 'cyan' }
];

const TIER_VALUES = [200, 400, 600];
const warnings = [];

// --- helpers ---------------------------------------------------------------

// Top-level parenthetical groups, tracking start/end indices.
function parenGroups(s) {
  const groups = [];
  let depth = 0, start = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(' || ch === '（') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === ')' || ch === '）') {
      depth--;
      if (depth === 0 && start >= 0) {
        groups.push({ text: s.slice(start + 1, i), start, end: i });
        start = -1;
      }
      if (depth < 0) depth = 0;
    }
  }
  return groups;
}

function cleanAnswer(a) {
  return String(a)
    .trim()
    .replace(/^الترتيب\s*:\s*/, '')
    // drop editorial annotations: "- تكرار", "، مكرر", "- سبق ذكره", "، استبدال: ..."
    // (no \b — Arabic letters are not \w, so \b would never match here)
    .replace(/\s*[-–—،|]\s*(تكرار|مكرر|سبق\s*ذكر\S*|استبدال|تصحيح)[\s\S]*$/u, '')
    .replace(/\s*\|[\s\S]*$/, '') // no answer legitimately contains "|" -> cut alternates
    .replace(/^[«"“]+|[»"”]+$/g, '')
    .replace(/[\s.．؟?:،\-–—)]+$/g, '')
    .trim();
}

function cleanQuestion(q) {
  return String(q)
    .replace(/^[\(（]?\s*س\s*\d+\s*[\)）]?\s*[:：.\-]?\s*/, '') // drop (س1)/(س2) marker
    .replace(/[\s|:\-–—.．]+$/g, '') // strip trailing separators/dashes/periods (keep ؟)
    .trim();
}

// Parse one "سؤال؟ (جواب)" chunk -> {q,a} using the LAST paren as the answer.
function parseQA(part) {
  part = part.trim();
  if (!part) return null;
  const groups = parenGroups(part);
  if (!groups.length) return null;
  const ans = groups[groups.length - 1];
  const a = cleanAnswer(ans.text);
  let q = (part.slice(0, ans.start) + part.slice(ans.end + 1)).trim();
  q = cleanQuestion(q);
  if (!q || !a) return null;
  return { q, a };
}

// Parse one "رتب ... (عناصر) ... (الترتيب)" unit -> {q, clues, a}.
function parseOrdering(line) {
  const groups = parenGroups(line);
  if (groups.length < 2) {
    const qa = parseQA(line);
    return qa ? { q: qa.q, a: qa.a, clues: null } : null;
  }
  const items = groups[0].text.split(/[،,]/).map((x) => x.trim()).filter(Boolean);
  const a = cleanAnswer(groups[groups.length - 1].text);
  let q = line.slice(0, groups[0].start).replace(/[\s|؟?:.\-]+$/g, '').trim();
  if (!q) q = 'رتب العناصر التالية بالترتيب الصحيح';
  return { q: q + '؟', clues: items, a };
}

// A tier line starts with a point value (200/300/400/500/600/700 ...) + ':'.
// Values are normalized to 200/400/600 by position, so any number works here.
// Split on "|" only at the top level (a "|" inside (...) is part of an answer).
function splitBars(s) {
  const out = [];
  let buf = '', depth = 0;
  for (const ch of s) {
    if (ch === '(' || ch === '（') depth++;
    else if (ch === ')' || ch === '）') depth = Math.max(0, depth - 1);
    if (ch === '|' && depth === 0) { out.push(buf); buf = ''; } else buf += ch;
  }
  out.push(buf);
  return out;
}

// "Q1 (A1) - تصحيح: Q2 (A2)" means "use the corrected Q2 instead of Q1".
// Keep only the text after the LAST top-level (depth 0) استبدال/تصحيح marker.
function stripToCorrection(slot) {
  const depthAt = [];
  let d = 0;
  for (let i = 0; i < slot.length; i++) {
    const ch = slot[i];
    if (ch === '(' || ch === '（') { depthAt[i] = d; d++; }
    else if (ch === ')' || ch === '）') { d = Math.max(0, d - 1); depthAt[i] = d; }
    else depthAt[i] = d;
  }
  const re = /(?:استبدال|تصحيح)\s*[:：]/g;
  let m, lastIdx = -1;
  while ((m = re.exec(slot))) { if (depthAt[m.index] === 0) lastIdx = m.index + m[0].length; }
  return lastIdx >= 0 ? slot.slice(lastIdx) : slot;
}

const isTier = (l) => /^(\d{2,4})\s*(نقطة|نقاط)?\s*[:：]/.test(l);
function tierRemainder(l) {
  return l.replace(/^(\d{2,4})\s*(نقطة|نقاط)?\s*[:：]\s*/, '');
}

// Category header? Returns 1..24 or null.
function headerNumber(l) {
  let m = l.match(/^(\d{1,2})\s*[.．]\s*\S/); // "1. الجغرافيا"
  if (m) { const n = +m[1]; if (n >= 1 && n <= 24) return n; }
  m = l.match(/[)）\s]\.?\s*(\d{1,2})\s*$/);  // "... .14"  /  "...).20"
  if (m && /[.．]\s*\d{1,2}\s*$/.test(l)) { const n = +m[1]; if (n >= 1 && n <= 24) return n; }
  return null;
}

const isVersionHeader = (l) => /^(?:Version|الإصدار)\s+[A-O]\b\s*(\(.*\))?\s*$/.test(l) && l.length < 40;

// --- read & split into versions -------------------------------------------

const raw = fs.readFileSync(srcPath, 'utf8');
const allLines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');

const versions = [];          // array of {letter, lines:[]}
let current = { letter: 'A', lines: [] };
versions.push(current);
for (const line of allLines) {
  if (isVersionHeader(line)) {
    const letter = line.match(/[A-O]/)[0];
    current = { letter, lines: [] };
    versions.push(current);
    continue;
  }
  // skip preamble/commentary paragraphs (e.g. "إليك الإصدار I، المصمم بأسئلة...")
  if (/(?:الإصدار|النسخة)\s+[A-O]/.test(line)) continue;
  current.lines.push(line);
}

// --- parse a single version into question rows -----------------------------

function parseVersion(vLines, versionNum) {
  const rows = [];
  // Split into category segments by header lines.
  const segments = [];
  let seg = null;
  for (const line of vLines) {
    const n = headerNumber(line);
    if (n) {
      seg = { num: n, header: line, body: [] };
      segments.push(seg);
    } else if (seg) {
      seg.body.push(line);
    } // lines before the first header (stray intros) are ignored
  }

  for (const s of segments) {
    const meta = CATEGORY_ORDER[s.num - 1];
    if (!meta) { warnings.push(`v${versionNum}: bad category number ${s.num}`); continue; }
    const slug = meta.slug;
    const isOrdering = slug === 'ordering';
    const isScenario = slug === 'crime' || slug === 'rescue';

    // Story for scenario categories: from header "...قصة: X" or a pre-tier line.
    let story = '';
    if (isScenario) {
      const hm = s.header.match(/(?:^|\s)(?:ال)?قصة\s*[:：]\s*(.+)$/);
      if (hm) story = hm[1].trim();
    }

    // Walk body: track current tier; collect questions.
    let tierIdx = -1;
    const collected = []; // {value, items:[parts]}
    for (const line of s.body) {
      if (isTier(line)) {
        tierIdx++;
        collected.push({ value: TIER_VALUES[Math.min(tierIdx, 2)], parts: [] });
        const rem = tierRemainder(line);
        if (rem) collected[collected.length - 1].parts.push(rem);
      } else if (tierIdx < 0) {
        // pre-tier line -> scenario story if not already set
        if (isScenario && !story) story = line.replace(/^(?:ال)?قصة\s*[:：]\s*/, '').trim();
      } else {
        // continuation line (ordering units / scenario continuation)
        collected[collected.length - 1].parts.push(line);
      }
    }

    if (collected.length !== 3) {
      warnings.push(`v${versionNum} ${slug} (#${s.num}): ${collected.length} tiers (expected 3)`);
    }

    let ord = 0;
    for (const tier of collected) {
      // Build the list of question-chunks for this tier.
      let chunks = [];
      if (isOrdering) {
        for (const p of tier.parts) {
          if (p.includes('رتب')) {
            chunks.push({ ordering: p.trim() }); // "رتب ... (عناصر) | (الترتيب)" — bar is internal
          } else {
            // numbered-list style: "1. عناصر | 2. عناصر"
            splitBars(p).forEach((x) => { const t = x.trim(); if (t) chunks.push({ orderingList: t }); });
          }
        }
      } else {
        for (const p of tier.parts) {
          // " | " separates the two questions; within each, "استبدال/تصحيح" replaces it.
          splitBars(p)
            .forEach((x) => { const t = stripToCorrection(x).trim(); if (t) chunks.push({ qa: t }); });
        }
      }

      for (const ch of chunks) {
        let row = null;
        if (ch.ordering) {
          const o = parseOrdering(ch.ordering);
          if (o) row = { type: 'normal', q: o.q, a: o.a, clues: o.clues || null };
        } else if (ch.orderingList) {
          const m = ch.orderingList.match(/^\d+\s*[.．]\s*(.+)$/);
          const itemsText = m ? m[1] : ch.orderingList;
          const items = itemsText.split(/[،,]/).map((x) => x.trim().replace(/[.．]+$/, '').trim()).filter(Boolean);
          if (items.length >= 2) {
            row = { type: 'normal', q: 'رتب العناصر التالية بالترتيب الصحيح؟', a: items.join('، '), clues: [...items].reverse() };
          }
        } else {
          let qa = parseQA(ch.qa);
          if (!qa && (slug === 'proverbs' || slug === 'verse')) {
            // later versions write the full proverb/verse with no (answer); last word is the answer.
            const stmt = ch.qa.replace(/[.．؟?]+$/g, '').trim();
            const words = stmt.split(/\s+/);
            if (words.length >= 2) { const last = words.pop(); qa = { q: words.join(' ') + ' ...؟', a: last }; }
          }
          if (qa) {
            let q = qa.q;
            // some versions write capitals/currencies tersely ("مصر؟"); restore the lead-in.
            if (slug === 'currencies' && !/عمل/.test(q)) q = 'عملة ' + q;
            if (slug === 'capitals' && !/عاصم/.test(q)) q = 'عاصمة ' + q;
            row = { type: 'normal', q, a: qa.a, clues: null };
            if (isScenario && story) row.note = story; // full scenario shown as an always-visible "case" panel
          }
        }
        if (!row) { warnings.push(`v${versionNum} ${slug} val${tier.value}: unparseable chunk: ${(ch.ordering || ch.orderingList || ch.qa).slice(0, 60)}`); continue; }
        rows.push({
          category: slug,
          version: versionNum,
          ord: ord++,
          value: tier.value,
          type: row.type,
          q: row.q,
          a: row.a,
          ...(row.clues ? { clues: row.clues } : {}),
          ...(row.note ? { note: row.note } : {})
        });
      }
    }
  }
  return rows;
}

// --- build output ----------------------------------------------------------

let questions = [];
versions.forEach((v, i) => {
  questions = questions.concat(parseVersion(v.lines, i + 1));
});

const categories = CATEGORY_ORDER.map((c) => ({
  slug: c.slug,
  name: c.name,
  color: c.color,
  image: `assets/img/categories/${c.slug}.png`
}));

// --- Flags category: use real flag images instead of text questions ---
const FLAG_POOL = [
  { code: 'sa', name: 'السعودية' }, { code: 'eg', name: 'مصر' }, { code: 'jo', name: 'الأردن' }, { code: 'ae', name: 'الإمارات' },
  { code: 'qa', name: 'قطر' }, { code: 'kw', name: 'الكويت' }, { code: 'ma', name: 'المغرب' }, { code: 'dz', name: 'الجزائر' },
  { code: 'tn', name: 'تونس' }, { code: 'ly', name: 'ليبيا' }, { code: 'ps', name: 'فلسطين' }, { code: 'sy', name: 'سوريا' },
  { code: 'iq', name: 'العراق' }, { code: 'lb', name: 'لبنان' }, { code: 'om', name: 'عُمان' }, { code: 'tr', name: 'تركيا' },
  { code: 'fr', name: 'فرنسا' }, { code: 'de', name: 'ألمانيا' }, { code: 'it', name: 'إيطاليا' }, { code: 'es', name: 'إسبانيا' },
  { code: 'gb', name: 'بريطانيا' }, { code: 'us', name: 'الولايات المتحدة' }, { code: 'ca', name: 'كندا' }, { code: 'jp', name: 'اليابان' },
  { code: 'cn', name: 'الصين' }, { code: 'in', name: 'الهند' }, { code: 'br', name: 'البرازيل' }, { code: 'ru', name: 'روسيا' },
  { code: 'ch', name: 'سويسرا' }, { code: 'se', name: 'السويد' }, { code: 'nl', name: 'هولندا' }, { code: 'pk', name: 'باكستان' }
];
const flagsMap = {};
const flagVals = [200, 200, 400, 400, 600, 600];
questions = questions.filter((q) => q.category !== 'flags');
versions.forEach((v, i) => {
  for (let k = 0; k < 6; k++) {
    const c = FLAG_POOL[(i * 6 + k) % FLAG_POOL.length];
    flagsMap[c.code] = `https://flagcdn.com/w320/${c.code}.png`;
    questions.push({ category: 'flags', version: i + 1, ord: k, value: flagVals[k], type: 'flag', flag: c.code, a: c.name, q: '' });
  }
});

const out = { categories, flags: flagsMap, questions };
fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');

// --- validation report -----------------------------------------------------

console.log(`Versions parsed: ${versions.length} (letters: ${versions.map((v) => v.letter).join(',')})`);
console.log(`Total questions: ${questions.length}`);

// per version count + per category count matrix
const perV = {};
const perVC = {};
for (const q of questions) {
  perV[q.version] = (perV[q.version] || 0) + 1;
  perVC[q.version] = perVC[q.version] || {};
  perVC[q.version][q.category] = (perVC[q.version][q.category] || 0) + 1;
}
console.log('Questions per version:', Object.entries(perV).map(([v, n]) => `v${v}:${n}`).join('  '));

// categories that do not have exactly 6 questions in some version
const odd = [];
for (const v of Object.keys(perVC)) {
  for (const c of CATEGORY_ORDER) {
    const n = perVC[v][c.slug] || 0;
    if (n !== 6) odd.push(`v${v}/${c.slug}=${n}`);
  }
}
console.log(`\nCategories not equal to 6 questions (${odd.length}):`);
console.log(odd.join('  '));

console.log(`\nWarnings (${warnings.length}):`);
warnings.slice(0, 80).forEach((w) => console.log('  - ' + w));
if (warnings.length > 80) console.log(`  ... and ${warnings.length - 80} more`);
