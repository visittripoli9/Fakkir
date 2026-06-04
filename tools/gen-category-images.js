/**
 * gen-category-images.js
 * Writes one self-contained HTML tile per category (1200x800) into a temp work dir.
 * A companion step rasterizes each to client/assets/img/categories/<slug>.png with
 * headless Edge. Tiles share one navy/gold brand style for a consistent set.
 *
 * Usage:  node tools/gen-category-images.js
 *         (prints the work dir + slug list for the rasterizer)
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

// slug, emoji icon, accent color
const CATS = [
  ['geo', '🌍', '#1f7bff'],
  ['history', '🏛️', '#d7a018'],
  ['palestine', '🕌', '#2b9e5b'],
  ['seerah', '🌙', '#16a3a3'],
  ['quran', '📖', '#2b9e5b'],
  ['flags', '🚩', '#d83a45'],
  ['sports', '🏅', '#1bb3c9'],
  ['football', '⚽', '#1f7bff'],
  ['riddles', '❓', '#7756c6'],
  ['science', '🔬', '#16a3a3'],
  ['tech', '💻', '#1bb3c9'],
  ['animals', '🦁', '#d7a018'],
  ['general', '💡', '#d7a018'],
  ['math', '➗', '#1f7bff'],
  ['whoami', '🎭', '#7756c6'],
  ['proverbs', '📜', '#16a3a3'],
  ['dish', '🍽️', '#d83a45'],
  ['crime', '🔍', '#d83a45'],
  ['rescue', '⚖️', '#2b9e5b'],
  ['closest', '🎯', '#7756c6'],
  ['capitals', '🏙️', '#1f7bff'],
  ['currencies', '💰', '#d7a018'],
  ['verse', '☪️', '#2b9e5b'],
  ['ordering', '🔢', '#1bb3c9']
];

const tile = (emoji, color) => `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0}
  .tile{width:1200px;height:800px;position:relative;overflow:hidden;display:flex;
    align-items:center;justify-content:center;
    font-family:"Segoe UI Emoji","Noto Color Emoji",sans-serif;
    background:
      radial-gradient(62% 60% at 50% 40%, ${color}55, transparent 62%),
      radial-gradient(120% 120% at 100% 0%, rgba(215,160,24,.16), transparent 55%),
      radial-gradient(120% 120% at 0% 100%, ${color}22, transparent 55%),
      linear-gradient(180deg,#10223a,#0a1626 60%,#060d16);}
  .dots{position:absolute;inset:0;background-image:radial-gradient(rgba(255,255,255,.05) 2.4px,transparent 2.4px);background-size:48px 48px}
  .ring{position:absolute;width:560px;height:560px;border-radius:50%;border:7px solid rgba(255,255,255,.07)}
  .glow{position:absolute;width:480px;height:480px;border-radius:50%;
    background:radial-gradient(circle at 50% 42%, ${color}66, ${color}10 60%, transparent 72%);
    filter:blur(2px)}
  .bar{position:absolute;bottom:90px;width:150px;height:10px;border-radius:999px;background:#d7a018;box-shadow:0 0 24px ${color}}
  .emoji{position:relative;font-size:380px;line-height:1;filter:drop-shadow(0 22px 34px rgba(0,0,0,.45))}
</style></head><body>
  <div class="tile"><div class="dots"></div><div class="glow"></div><div class="ring"></div><span class="emoji">${emoji}</span><div class="bar"></div></div>
</body></html>`;

const dir = path.join(os.tmpdir(), 'cat-gen');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
for (const [slug, emoji, color] of CATS) {
  fs.writeFileSync(path.join(dir, slug + '.html'), tile(emoji, color), 'utf8');
}
console.log(dir);
console.log(CATS.length + ' tiles: ' + CATS.map((c) => c[0]).join(' '));
