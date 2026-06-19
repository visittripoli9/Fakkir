const CONFIG = window.FAKKIR_CONFIG || {};
let DATA = null;
let DATA_SOURCE = 'local';
let SUPABASE = null;
let timerInt = null;
let _audio = null;
let USER = null;               // current authenticated Supabase user, or null
let pendingAfterAuth = null;   // action to run once login succeeds (e.g. 'blitz')
let authMode = 'signin';       // 'signin' | 'signup' for the auth screen
let blitzLbFilter = 'all';     // Blitz leaderboard version filter: 'all' | version number

const SKIPS_PER_TEAM = 3;     // limited skips each team gets per match
const GOLDEN_PER_BOARD = 2;   // random double-point questions on the board

const state = {
  selected: [], used: {}, current: null, turn: 'blue',
  teams: { blue: { name: 'الفريق الأزرق', score: 0, skips: SKIPS_PER_TEAM }, red: { name: 'الفريق الأحمر', score: 0, skips: SKIPS_PER_TEAM } },
  settings: { timer: 15, sound: true, version: 1 },
  events: [],
  awards: {},          // { blue?:{state,base,golden,key}, red?:{...} } — per-team verdict for the current question (editable on the result screen)
  lastQ: null,         // { base, golden, key } — meta of the just-finished question, so any team's verdict can be re-scored
  challengeDone: false,// end-game comeback round used?
  special: null,       // null | 'challenge' | 'tiebreak'
  screen: 'home',      // last active screen (for restore-after-reload)
  finished: false,     // has this match been concluded?
  matchSaved: false,   // has the final result been persisted? (save-once guard)
  timerEndsAt: null    // epoch ms when the current question timer expires (for resume)
};

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const other = t => t === 'blue' ? 'red' : 'blue';
// escape for safe innerHTML interpolation (XSS defence)
const safe = v => String(v ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
// asset cache-buster: bump when bundled images change so browsers/service worker
// fetch the new file instead of an old cached copy (category art has no other version tag)
const ASSET_V = 17;
const bust = u => !u ? u : (u.startsWith('http') ? u : u + (u.includes('?') ? '&' : '?') + 'v=' + ASSET_V);

// ---- security helpers: bounds + input sanitisation ----
const STATE_VERSION = 3;          // saved-state schema version (bump invalidates old/incompatible saves)
const NAME_MAX = 40;              // max team-name length
const SCORE_MIN = -100000, SCORE_MAX = 100000; // scores can go negative (deductions), but stay bounded
const clampScore = v => Math.max(SCORE_MIN, Math.min(SCORE_MAX, Math.trunc(Number(v) || 0)));
const clampSkips = v => Math.max(0, Math.min(SKIPS_PER_TEAM, Math.trunc(Number(v) || 0)));
// strip control chars, collapse whitespace, clamp length; never trust raw input/localStorage
function sanitizeName(v, fallback){
  // drop control chars (incl. DEL) by code point, trim, and clamp length; no regex escapes needed
  let out = '';
  for(const ch of String(v ?? '')){ const c = ch.codePointAt(0); if(c >= 32 && c !== 127) out += ch; }
  const s = out.trim().slice(0, NAME_MAX);
  return s || fallback;
}
let recoveredCorruptState = false; // set when a corrupt/outdated save was discarded on load

function toast(msg){
  const t = $('#toast');
  if(!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(()=>t.classList.remove('show'),2400);
}

function setStatus(text, kind='ok'){
  const el = $('#dbStatus');
  if(!el) return;
  el.textContent = text || '';
  el.dataset.kind = kind;
  el.style.display = text ? '' : 'none'; // hidden when empty (players never see data-source details)
}

function show(id){
  // leaving the Blitz screen mid-run (e.g. via a nav link) stops its timer cleanly
  if(id !== 'blitz' && typeof blitz !== 'undefined' && blitz.active){ blitz.active = false; clearInterval(blitzInt); }
  $$('.screen').forEach(s=>s.classList.remove('active'));
  const screen = $('#'+id);
  if(screen) screen.classList.add('active');
  $$('.nav-link').forEach(b=>b.classList.toggle('active', b.dataset.screen===id));
  const mn=$('#mainNav'); if(mn) mn.classList.remove('open');
  const nt=$('#navToggle'); if(nt){ nt.classList.remove('open'); nt.setAttribute('aria-expanded','false'); }
  renderHeader();
  if(id === 'category') renderCategories();
  if(id === 'board') buildBoard();
  if(id === 'leaderboard') renderLeaderboard();
  if(id === 'achievements') renderAchievements();
  if(id === 'profile') renderProfile();
  if(id === 'settings') syncSettingsControls();
  if(id === 'home') updateResumeUI();
  state.screen = id;          // remember where we are so a reload can restore it
  saveLocal();
  window.scrollTo({top:0, behavior:'smooth'});
}

async function loadScript(src, integrity){
  return new Promise((resolve,reject)=>{
    if([...document.scripts].some(s => s.src === src)) return resolve();
    const s=document.createElement('script');
    s.src=src; s.onload=resolve; s.onerror=reject;
    // Subresource Integrity + CORS: the browser refuses to run the file if its
    // hash doesn't match (protects against a tampered/compromised CDN).
    if(integrity){ s.integrity=integrity; s.crossOrigin='anonymous'; s.referrerPolicy='no-referrer'; }
    document.head.appendChild(s);
  });
}

// pinned, integrity-checked supabase-js (supply-chain safety — bump both together)
const SUPABASE_JS_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.108.2';
const SUPABASE_JS_SRI = 'sha384-JWEyvHh+lRf0sN/WWY+QTQwX+CyWqmNg4tkc8GQzAMEtR2wGNrCJlvnu1lHD1kDm';

async function initSupabase(){
  if(!CONFIG.supabaseUrl || !CONFIG.supabaseAnonKey) return null;
  try{
    await loadScript(SUPABASE_JS_URL, SUPABASE_JS_SRI);
    SUPABASE = window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey);
    return SUPABASE;
  }catch(e){
    console.warn('Supabase client unavailable', e);
    return null;
  }
}

function normalizeQuestion(row){
  return {
    category: row.category,
    version: Number(row.version || 1),
    ord: Number(row.ord || 0),
    value: Number(row.value || 0),
    type: row.type || 'normal',
    q: row.q || '',
    a: row.a || '',
    note: row.note || '',
    flag: row.flag || '',
    image: row.image || '',
    clues: Array.isArray(row.clues) ? row.clues : (row.clues ? JSON.parse(row.clues) : null),
    num: row.num == null ? null : Number(row.num),
    evidence: row.evidence || '',
    suspects: Array.isArray(row.suspects) ? row.suspects : (row.suspects ? JSON.parse(row.suspects) : null)
  };
}

// PostgREST caps a response at 1000 rows, so page through all questions.
async function loadAllQuestions(sb){
  const cols = 'category,version,ord,value,type,q,a,note,flag,clues,num,evidence,suspects,image';
  const pageSize = 1000;
  let from = 0, all = [];
  for(;;){
    const { data, error } = await sb.from('questions').select(cols)
      .order('category').order('version').order('ord')
      .range(from, from + pageSize - 1);
    if(error) throw error;
    all = all.concat(data || []);
    if(!data || data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

async function loadFromSupabase(){
  const sb = await initSupabase();
  if(!sb) throw new Error('Supabase is not configured');

  const [catsRes, flagsRes] = await Promise.all([
    sb.from('categories').select('slug,name,color,image,sort_order').order('sort_order', { ascending: true }),
    sb.from('flags').select('key,image')
  ]);
  if(catsRes.error) throw catsRes.error;
  if(flagsRes.error) throw flagsRes.error;

  const questions = await loadAllQuestions(sb);

  const flags = {};
  (flagsRes.data || []).forEach(f => { flags[f.key] = f.image; });
  return {
    categories: (catsRes.data || []).map(c => ({
      slug: c.slug,
      name: c.name,
      color: c.color || 'blue',
      image: c.image || `assets/img/categories/${c.slug}.png`
    })),
    questions: questions.map(normalizeQuestion),
    flags
  };
}

async function api(path, opts){
  const base = CONFIG.apiBase || '/api';
  const r = await fetch(base + path, opts);
  if(!r.ok) throw new Error('API error');
  return r.json();
}

async function loadFromApi(){ return api('/game-data'); }
async function loadLocal(){ return (await fetch('assets/data.json')).json(); }

async function loadData(){
  const attempts = [];
  if(CONFIG.preferSupabase !== false) attempts.push(['supabase', loadFromSupabase]);
  attempts.push(['api', loadFromApi]);
  if(CONFIG.fallbackToLocal !== false) attempts.push(['local', loadLocal]);

  for(const [source, fn] of attempts){
    try{
      DATA = await fn();
      localizeFlags(DATA);          // always serve flags from the app project folder, not a remote CDN
      await mergeLocalOnlyCategories(source); // surface bundled categories (e.g. players) missing from the source
      DATA_SOURCE = source;
      setStatus('', 'ok'); // hide the technical data-source banner from players
      return;
    }catch(e){
      console.warn(`Data load failed from ${source}`, e);
    }
  }
  throw new Error('No data source available');
}

// Some categories live only in the bundled local data (e.g. a newly added
// "احزر اللاعب" not yet seeded into Supabase). Merge any such category — with
// its questions and any extra flag images — from assets/data.json so it always
// shows, no matter which source loaded. No-op when local is already the source.
async function mergeLocalOnlyCategories(source){
  if(source === 'local' || !DATA || !Array.isArray(DATA.categories)) return;
  try{
    const local = await loadLocal();
    const have = new Set(DATA.categories.map(c => c.slug));
    const missing = (local.categories || []).filter(c => !have.has(c.slug));
    if(!missing.length) return;
    const slugs = new Set(missing.map(c => c.slug));
    DATA.categories = DATA.categories.concat(missing);
    DATA.questions = DATA.questions.concat((local.questions || []).filter(q => slugs.has(q.category)));
    DATA.flags = Object.assign({}, local.flags, DATA.flags); // keep source flags, add any local-only ones
    localizeFlags(DATA);
  }catch(e){ console.warn('local category merge skipped', e); }
}

// Force every flag to its bundled local image (assets/img/flags/<code>.png) no
// matter what the data source returned. This keeps all flags inside the app
// project folder so they can never break (remote CDN down / blocked by CSP).
function localizeFlags(data){
  if(!data || !data.flags || typeof data.flags !== 'object') return;
  for(const code of Object.keys(data.flags)){
    data.flags[code] = `assets/img/flags/${code}.png`;
  }
}

function saveLocal(){
  state.v = STATE_VERSION;
  try{ localStorage.setItem('fakkir_state_v2', JSON.stringify(state)); }
  catch(e){ /* storage full / disabled (private mode) — game still works in-memory */ }
}

// shape check: only restore a save that matches the current schema and looks sane.
function isSaneSavedState(s){
  if(!s || typeof s !== 'object' || s.v !== STATE_VERSION) return false;
  if(!s.teams || typeof s.teams !== 'object' || !s.teams.blue || !s.teams.red) return false;
  const okTeam = t => t && typeof t.name === 'string' && Number.isFinite(Number(t.score));
  if(!okTeam(s.teams.blue) || !okTeam(s.teams.red)) return false;
  if(!Array.isArray(s.selected)) return false;
  if(s.used != null && typeof s.used !== 'object') return false;
  return true;
}

// clamp every restored value so a hand-edited localStorage cannot create fake
// scores, extra skips, broken turns, or otherwise corrupt the game state.
function sanitizeState(){
  for(const k of ['blue','red']){
    const tm = state.teams[k] || (state.teams[k] = {});
    tm.name = sanitizeName(tm.name, k==='blue' ? 'الفريق الأزرق' : 'الفريق الأحمر');
    tm.score = clampScore(tm.score);
    tm.skips = clampSkips(tm.skips);
  }
  state.selected = (Array.isArray(state.selected) ? state.selected : []).filter(s => typeof s === 'string').slice(0,6);
  if(!state.used || typeof state.used !== 'object') state.used = {};
  if(state.turn !== 'blue' && state.turn !== 'red') state.turn = 'blue';
  if(typeof state.finished !== 'boolean') state.finished = false;
  if(typeof state.matchSaved !== 'boolean') state.matchSaved = false;
  if(typeof state.timerEndsAt !== 'number') state.timerEndsAt = null;
  if(!state.settings || typeof state.settings !== 'object') state.settings = { timer:15, sound:true, version:1 };
  if(!Array.isArray(state.events)) state.events = [];
  if(!state.awards || typeof state.awards !== 'object' || Array.isArray(state.awards)) state.awards = {};
  if(state.lastQ != null && typeof state.lastQ !== 'object') state.lastQ = null;
}

function loadLocalState(){
  let raw = null, saved = null;
  try{ raw = localStorage.getItem('fakkir_state_v2'); saved = raw ? JSON.parse(raw) : null; }
  catch(e){ saved = null; }
  if(saved && isSaneSavedState(saved)){
    Object.assign(state, saved);
  } else if(raw){
    // corrupted, tampered, or outdated save -> discard safely and start clean
    try{ localStorage.removeItem('fakkir_state_v2'); }catch(e){}
    recoveredCorruptState = true;
  }
  sanitizeState(); // always clamp/repair, even for accepted saves
}

// A match is "active" (resumable) when there is a real, unfinished game to
// return to: 6 categories locked in, the match not concluded, and either a
// question open right now OR questions still left to play on the board. This
// shows the "continue match?" prompt whenever a genuine match is in progress,
// while keeping it hidden on a fresh visit (no categories) or a finished /
// fully-played board.
function hasActiveMatch(){
  if(!Array.isArray(state.selected) || state.selected.length !== 6 || state.finished) return false;
  if(isValidCurrent(state.current)) return true;     // a question is open right now -> definitely resumable
  if(!DATA) return true;                             // data not loaded yet: trust the validated saved shape
  return remainingQuestions().length > 0;            // still questions left to play -> match is in progress
}

function askConfirm(msg){
  try{ return window.confirm(msg); }catch(e){ return true; }
}

// show/hide the "continue match" bar on the home screen
function updateResumeUI(){
  const bar = $('#resumeBar'); if(!bar) return;
  bar.classList.toggle('hidden', !hasActiveMatch());
}

// is a restored current-question object structurally valid (vs a tampered save)?
function isValidCurrent(cur){
  return cur && typeof cur === 'object' && cur.q && cur.c && typeof cur.key === 'string'
    && (cur.answerer === 'blue' || cur.answerer === 'red');
}

// resume the match exactly where it was left
function continueMatch(){
  if(!hasActiveMatch()) return show('board');
  if(isValidCurrent(state.current)){
    renderCurrentQuestion({ resume:true }); // mid-question -> rebuild it (resume timer)
  } else {
    state.current = null;                    // drop any malformed current and fall back safely
    show('board');                           // the board is the live hub
  }
}

// On reload, restore the screen the player was last on instead of always
// dropping them on the home page. Live-gameplay screens are only restored when
// there is a genuine match to resume; transient screens fall back sensibly.
function restoreScreen(){
  const saved = state.screen || 'home';
  // mid-game board/question: rebuild the board, or resume the open question + its timer
  if(hasActiveMatch() && (saved === 'board' || saved === 'question')){
    return continueMatch();
  }
  // these screens only make sense with live state we no longer have after a reload
  if(saved === 'board' || saved === 'question' || saved === 'result'){
    return show(hasActiveMatch() ? 'board' : 'home');
  }
  // otherwise return to exactly where they were (settings, rules, leaderboard, category, home)
  const known = ['home', 'category', 'leaderboard', 'rules', 'settings'];
  show(known.includes(saved) ? saved : 'home');
}

// clear the saved match and start a fresh one (with confirmation if a match is in progress)
function startNewMatch(){
  if(hasActiveMatch() && !askConfirm('بدء مباراة جديدة سيمسح تقدّم المباراة الحالية. هل تريد المتابعة؟')) return;
  clearInterval(timerInt);
  startFlow();
}

// resolve the active theme: an explicit saved choice wins, otherwise follow the device
function resolveTheme(){
  const saved = localStorage.getItem('theme');
  if(saved === 'dark' || saved === 'light') return saved;
  try{ return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; }
  catch(e){ return CONFIG.defaultTheme || 'light'; }
}

function renderHeader(){
  const theme = resolveTheme();
  document.body.dataset.theme = theme;
  $('#blueName').value = state.teams.blue.name;
  $('#redName').value = state.teams.red.name;
  const bhs = $('#blueHomeScore'); if(bhs) bhs.textContent = state.teams.blue.score;
  const rhs = $('#redHomeScore'); if(rhs) rhs.textContent = state.teams.red.score;
  $('#themeLabel').textContent = theme === 'dark' ? 'نهاري' : 'ليلي';
}

function renderCategories(){
  if(!DATA) return;
  const grid = $('#categoriesGrid');
  grid.innerHTML='';
  DATA.categories.forEach(cat=>{
    const idx = state.selected.indexOf(cat.slug);
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'cat-card' + (idx>=0?' selected':'');
    el.dataset.color = cat.color || 'blue';
    el.innerHTML = `<img class="cc-img" src="${safe(bust(cat.image))}" alt="${safe(cat.name)}">`
      + `<span class="cc-num">${idx>=0?idx+1:''}</span>`
      + `<div class="cc-overlay"><h3 class="cc-title">${safe(cat.name)}</h3>`
      + `<span class="cc-count">${countQuestions(cat.slug)} أسئلة</span></div>`;
    el.onclick = () => toggleCategory(cat.slug);
    grid.appendChild(el);
  });
  $('#catCount').textContent = `اخترت ${state.selected.length} من 6`;
  $('#goBoard').disabled = state.selected.length !== 6;
}

function countQuestions(slug){ return DATA.questions.filter(q => q.category === slug && q.version === state.settings.version).length; }
function toggleCategory(slug){
  const i = state.selected.indexOf(slug);
  if(i>=0){ state.selected.splice(i,1); sfx('click'); }
  else {
    if(state.selected.length>=6) return toast('اخترت 6 فئات بالفعل');
    state.selected.push(slug);
    sfx('select', 12);
  }
  state.golden={}; // board composition changed — re-roll golden tiles next time
  saveLocal();
  renderCategories();
}

function startFlow(){
  sfx('start', 20);
  state.teams.blue.name = sanitizeName($('#blueName').value, 'الفريق الأزرق');
  state.teams.red.name = sanitizeName($('#redName').value, 'الفريق الأحمر');
  state.teams.blue.score = 0;
  state.teams.red.score = 0;
  state.teams.blue.skips = SKIPS_PER_TEAM;
  state.teams.red.skips = SKIPS_PER_TEAM;
  state.turn='blue';
  state.used={};
  state.selected=[];
  state.events=[];
  state.awards={};
  state.lastQ=null;
  state.challengeDone=false;
  state.special=null;
  state.current=null;
  state.finished=false;
  state.matchSaved=false;
  state.timerEndsAt=null;
  clearInterval(timerInt);
  saveLocal();
  renderCategories();
  show('category');
}
function randomCats(){ state.selected = [...DATA.categories].sort(()=>Math.random()-.5).slice(0,6).map(c=>c.slug); saveLocal(); renderCategories(); }
function clearCats(){ state.selected=[]; saveLocal(); renderCategories(); }
function qList(slug){ return DATA.questions.filter(q=>q.category===slug && q.version===state.settings.version).sort((a,b)=>a.ord-b.ord); }
function cat(slug){ return DATA.categories.find(c=>c.slug===slug); }

function renderSkips(){
  const fmt = n => `تخطيات: ${n}`;
  const bs=$('#blueSkips'); if(bs) bs.textContent = fmt(state.teams.blue.skips);
  const rs=$('#redSkips'); if(rs) rs.textContent = fmt(state.teams.red.skips);
}

function buildBoard(){
  const grid = $('#boardGrid');
  grid.innerHTML='';
  $('#blueBoardName').textContent = state.teams.blue.name;
  $('#redBoardName').textContent = state.teams.red.name;
  if(window.FX){ window.FX.countUp($('#blueScore'), state.teams.blue.score); window.FX.countUp($('#redScore'), state.teams.red.score); }
  else { $('#blueScore').textContent = state.teams.blue.score; $('#redScore').textContent = state.teams.red.score; }
  $('#turnLabel').textContent = state.teams[state.turn].name;
  renderSkips();

  state.selected.forEach(slug=>{
    const c = cat(slug);
    const qs = qList(slug).slice(0,6);
    const tile = document.createElement('section');
    tile.className='board-tile';
    tile.dataset.color = c.color || 'blue';
    tile.innerHTML = `<div class="bt-media"><img src="${safe(bust(c.image))}" alt="${safe(c.name)}"><h3 class="bt-title">${safe(c.name)}</h3></div><div class="points-grid">` + qs.map(q=>{
      const key = `${slug}:${q.ord}`;
      return `<button class="point-btn ${state.used[key]?'used':''}" data-slug="${safe(slug)}" data-ord="${q.ord}">${q.value}</button>`;
    }).join('') + `</div>`;
    grid.appendChild(tile);
  });
  $$('.point-btn').forEach(b=> b.onclick = () => openQuestion(b.dataset.slug, Number(b.dataset.ord)) );
}

function questionTitle(type){
  return {flag:'ما الدولة صاحبة هذا العلم؟', clues:'من أنا؟', dish:'ما هي الأكلة؟', crime:'من الجاني؟ وما الدليل؟', rescue:'هل المتهم بريء أم مذنب؟', closest:'ما الرقم الأقرب؟'}[type] || 'أجب عن السؤال';
}

// configure which action buttons show for the current question mode
function setActionMode(mode){
  const showEl = (sel, on) => { const el=$(sel); if(el) el.classList.toggle('hidden', !on); };
  showEl('#correctBtn', mode!=='tiebreak');
  showEl('#wrongBtn', mode!=='tiebreak');
  showEl('#passBtn', mode==='normal');
  showEl('#showAnswerBtn', true);
  showEl('#tbBlueBtn', mode==='tiebreak');
  showEl('#tbRedBtn', mode==='tiebreak');
}

function openQuestion(slug, ord, opts={}){
  // anti-cheat: never open a question that is already answered, or while another is active
  if(state.current) return;
  const q = qList(slug).find(x=>x.ord===ord);
  const c = cat(slug);
  const key=`${slug}:${ord}`;
  if(!q || state.used[key]) return; // already used -> can't be answered/scored twice
  const mode = opts.mode || 'normal';
  const answerer = opts.answerer || state.turn;
  sfx('select', 12);         // tactile feedback when a tile is opened
  state.awards = {};         // fresh question -> no verdicts recorded yet
  state.current = { q, c, key, picker: answerer, answerer, phase:'initial', shown:false, mode };
  renderCurrentQuestion();   // builds the question screen from state.current (also starts a fresh timer)
  saveLocal();               // persist immediately: a question was opened
}

// Render the question screen from state.current. Used both when opening a question and when
// restoring a match after reload (opts.resume keeps the remaining timer instead of restarting).
function renderCurrentQuestion(opts={}){
  const cur = state.current; if(!cur) return;
  const { q, c, mode } = cur;
  state.special = mode==='normal' ? null : mode;
  setActionMode(mode);
  updateSkipButton();
  $('#qCat').textContent = mode==='challenge' ? ('جولة التحدي · '+c.name) : (mode==='tiebreak' ? ('سؤال الحسم · '+c.name) : c.name);
  $('#qValue').textContent = `${q.value} نقطة`;
  const gb = $('#qGolden');
  if(gb){
    const label = mode==='challenge' ? '🔥 تحدٍّ ×٢' : '';
    gb.textContent = label;
    gb.classList.toggle('hidden', !label);
  }
  const story = (q.category==='crime' || q.category==='rescue') ? (q.note||'') : '';
  const qs = $('#qStory'); if(qs){ qs.textContent = story; qs.classList.toggle('hidden', !story); }
  $('#qText').textContent = q.q || questionTitle(q.type);
  $('#qBlueName').textContent = state.teams.blue.name;
  $('#qRedName').textContent = state.teams.red.name;
  $('#qBlueScore').textContent = state.teams.blue.score;
  $('#qRedScore').textContent = state.teams.red.score;
  $('#answerBox').classList.add('hidden');
  $('#answerBox').textContent = '';
  updateQTurn();
  renderVisual(q,c,'#qVisual');
  const noTimer = (q.category==='crime' || q.category==='rescue'); // scenarios need reading time
  const timerEl = $('#timer'); if(timerEl) timerEl.style.display = noTimer ? 'none' : '';
  if(noTimer){
    clearInterval(timerInt);
  } else if(opts.resume && state.timerEndsAt){
    // resume after reload, but never grant MORE than the configured time (anti clock-manipulation)
    const maxT = Number($('#timerSetting')?.value || state.settings.timer || 15);
    const remaining = Math.min(maxT, Math.ceil((state.timerEndsAt - Date.now())/1000));
    if(remaining > 0) startTimerFrom(remaining); else startTimer(); // expired during reload -> fresh time
  } else {
    startTimer();
  }
  show('question');
}

function renderVisual(q,c,target,opts={}){
  const box = $(target);
  box.innerHTML='';
  const img = document.createElement('img');
  // q.image is an ANSWER reveal (e.g. a player photo) — show it only in answer
  // context (result screen / after "show answer"), never in the live question,
  // or it would give the answer away. Flag images ARE the question, so they
  // always show. Everything else falls back to the category icon.
  const reveal = !!opts.reveal;
  const flagSrc = (q.type === 'flag' && q.flag && DATA.flags[q.flag]) ? DATA.flags[q.flag] : null;
  img.src = (q.image && reveal) ? q.image : (flagSrc || bust(c.image));
  img.alt = c.name; // keep the category name (never the answer) as alt text
  box.appendChild(img);
  if(q.clues){
    const list=document.createElement('div'); list.className = 'clue-list';
    list.innerHTML = q.clues.map(x=>`<span>${safe(x)}</span>`).join('');
    box.appendChild(list);
  }
  if(q.suspects){
    const list=document.createElement('div'); list.className = 'clue-list';
    list.innerHTML = q.suspects.map(x=>`<span>${safe(x)}</span>`).join('');
    box.appendChild(list);
  }
}

function handleTimeout(){
  const cur = state.current; if(!cur) return;
  if(cur.mode==='challenge'){ beep(170,0.3,'square'); finishChallenge(false); }
  else if(cur.mode==='tiebreak'){ toast('انتهى الوقت — على المقدّم اختيار الفريق الفائز'); }
  else timeoutPass();
}

// timer ran out: the question is UNANSWERED (no deduction) and the chance passes to the other team
function timeoutPass(){
  const cur = state.current; if(!cur) return; // guard: a terminal action already cleared the question
  sfx('wrong', [60,30,60]);
  if(cur.phase==='initial'){
    cur.phase = 'steal';
    cur.answerer = other(cur.answerer);
    sfx('steal');
    updateQTurn();
    updateSkipButton();
    $('#answerBox').classList.add('hidden');
    toast('⏰ انتهى الوقت دون إجابة — الفرصة الآن لـ ' + state.teams[cur.answerer].name);
    const noTimer = (cur.q.category==='crime' || cur.q.category==='rescue');
    if(!noTimer) startTimer();
    saveLocal();
    return;
  }
  // the stealing team also ran out of time — end as unanswered, no points changed
  setAward(cur.answerer, 'none');
  toast('⏰ انتهى الوقت — لم يُجب أي فريق');
  finishQuestion('انتهى الوقت — بدون إجابة', null);
}
function startTimer(){ startTimerFrom(Number($('#timerSetting').value||15)); }

// run the question timer for `secs` seconds, persisting the deadline so a reload can resume it
function startTimerFrom(secs){
  clearInterval(timerInt);
  let n = Math.max(1, Math.round(secs));
  state.timerEndsAt = Date.now() + n*1000;
  const timerEl = $('#timer');
  timerEl.textContent = n;
  timerEl.classList.remove('urgent');
  saveLocal();
  timerInt = setInterval(()=>{
    n--;
    timerEl.textContent = Math.max(0, n);
    // final 5 seconds: urgent pulse + ticking
    const urgent = n > 0 && n <= 5;
    timerEl.classList.toggle('urgent', urgent);
    if(urgent){ sfx('tick'); fxHaptic(15); }
    if(n<=0){ clearInterval(timerInt); state.timerEndsAt = null; timerEl.classList.remove('urgent'); handleTimeout(); }
  },1000);
}

function answerText(q){
  if(q.type==='crime') return `الجاني: ${q.a}`;
  if(q.type==='rescue') return `الحكم: ${q.a}`;
  if(q.type==='closest') return `الرقم الصحيح: ${q.num || q.a}`;
  return `الإجابة: ${q.a}`;
}
function showAnswer(){
  const cur=state.current; const q=cur.q;
  const box=$('#answerBox');
  const scenario = q.category==='crime' || q.category==='rescue'; // note holds the case story, already shown
  box.textContent = answerText(q) + (!scenario && q.note?` — ${q.note}`:'') + (q.evidence?` — ${q.evidence}`:'');
  box.classList.remove('hidden');
  if(q.image) renderVisual(q, cur.c, '#qVisual', {reveal:true}); // revealing the answer reveals the player photo too
}
function updateQTurn(){
  const cur = state.current; const el = $('#qTurn'); if(!el || !cur) return;
  if(cur.mode==='tiebreak'){ el.className='q-turn'; el.textContent='سؤال الحسم — أول إجابة صحيحة تفوز'; return; }
  const name = state.teams[cur.answerer].name;
  const steal = cur.phase==='steal';
  el.className = 'q-turn ' + cur.answerer + (steal ? ' steal' : '');
  if(cur.mode==='challenge') el.textContent = 'جولة التحدي: ' + name;
  else el.textContent = steal ? ('محاولة السرقة: ' + name) : ('الدور: ' + name);
}
function refreshQScores(){ $('#qBlueScore').textContent = state.teams.blue.score; $('#qRedScore').textContent = state.teams.red.score; }

// keep the skip button honest about the on-turn team's remaining skips (and warn when a skip would be penalized)
function updateSkipButton(){
  const btn = $('#passBtn'); const cur = state.current; if(!btn || !cur) return;
  if(cur.phase === 'initial'){
    const left = state.teams[cur.picker].skips;
    btn.textContent = left > 0 ? `تخطي (${left})` : 'تخطي (0) — يُحتسب خطأ';
    btn.classList.toggle('no-skips', left <= 0);
  } else {
    btn.textContent = 'تمرير'; // stealing team simply declines — no token, no penalty
    btn.classList.remove('no-skips');
  }
}

// signed points currently applied for a recorded verdict (golden doubles ONLY a correct answer)
const awardDelta = a => a.state==='correct' ? a.base * (a.golden ? 2 : 1) : (a.state==='wrong' ? -a.base : 0);

// Record (or change) a team's verdict for the current question and adjust its
// score by exactly the difference. Works live (state.current set) and while
// editing on the result screen (state.current null -> falls back to state.lastQ),
// so every team's correct/wrong/none decision is fully correctable afterwards.
function setAward(team, verdict){
  const meta = state.current
    ? { base: state.current.q.value, golden: !!state.current.golden, key: state.current.key }
    : (state.lastQ || { base: 0, golden: false, key: null });
  const prev = state.awards[team];
  if(prev) state.teams[team].score -= awardDelta(prev);          // undo what's applied now
  const next = { team, state: verdict, base: meta.base, golden: meta.golden, key: meta.key };
  state.teams[team].score += awardDelta(next);                    // apply the new verdict once
  state.teams[team].score = clampScore(state.teams[team].score);
  state.awards[team] = next;
  return next;
}

function correctAnswer(){
  const cur = state.current; if(!cur) return;
  sfx('correct', 30);
  if(cur.mode==='challenge') return finishChallenge(true);
  setAward(cur.answerer, 'correct');
  finishQuestion(cur.phase==='steal' ? 'سرقة ناجحة' : 'إجابة صحيحة', cur.answerer);
}

function wrongAnswer(reason){
  const cur = state.current; if(!cur) return;
  sfx('wrong', [40,40,40]);
  if(cur.mode==='challenge') return finishChallenge(false); // comeback round stays a bonus: no deduction
  setAward(cur.answerer, 'wrong'); // wrong answer = normal base deduction (golden never penalizes extra)
  const lead = reason ? (reason + ' — ') : '';
  if(cur.phase==='initial'){
    // deducted from the team on turn — now hand the question to the other team to steal
    refreshQScores();
    cur.phase = 'steal';
    cur.answerer = other(cur.answerer);
    sfx('steal');
    updateQTurn();
    updateSkipButton();
    $('#answerBox').classList.add('hidden');
    toast(lead + 'إجابة خاطئة (−' + cur.q.value + ') — فرصة سرقة لـ ' + state.teams[cur.answerer].name);
    const noTimer = (cur.q.category==='crime' || cur.q.category==='rescue');
    if(!noTimer) startTimer();
    saveLocal();
    return;
  }
  // stealing team also wrong — setAward above already recorded its deduction
  if(reason) toast(lead + 'إجابة خاطئة (−' + cur.q.value + ')');
  finishQuestion('إجابة خاطئة', cur.answerer);
}

function passQuestion(){
  const cur = state.current; if(!cur || cur.mode!=='normal') return;
  if(cur.phase==='initial'){
    const team = cur.picker;
    if(state.teams[team].skips <= 0){
      // no skips left: a skip attempt is treated as a wrong answer (deduct + pass). Deducts exactly once.
      return wrongAnswer('لا تخطيات متبقية');
    }
    state.teams[team].skips--;
    sfx('pass');
    renderSkips();
    cur.phase = 'steal';
    cur.answerer = other(team);
    updateQTurn();
    updateSkipButton();
    $('#answerBox').classList.add('hidden');
    toast('تخطٍّ — فرصة سرقة لـ ' + state.teams[cur.answerer].name + ' (تبقّى ' + state.teams[team].skips + ' تخطٍّ)');
    const noTimer = (cur.q.category==='crime' || cur.q.category==='rescue');
    if(!noTimer) startTimer();
    saveLocal();
    return;
  }
  // the stealing team declines the steal — no points, no token spent
  setAward(cur.answerer, 'none');
  finishQuestion('تخطي', null);
}

// reveal (only on the result screen) whether the question was secretly golden
function renderGoldenReveal(){
  const gr = $('#goldenReveal'); if(!gr) return;
  const isGolden = !!(state.lastQ && state.lastQ.golden);
  gr.classList.toggle('hidden', !isGolden);
  if(!isGolden) return;
  const anyCorrect = Object.values(state.awards || {}).some(a => a && a.state === 'correct');
  gr.textContent = anyCorrect
    ? '⭐ مفاجأة! كان سؤالًا ذهبيًا — تمت مضاعفة النقاط (×٢)'
    : '⭐ مفاجأة! كان هذا سؤالًا ذهبيًا';
}

function finishQuestion(title, team){
  clearInterval(timerInt);
  state.timerEndsAt = null; // no live timer on the result screen
  const cur = state.current; if(!cur) return;
  state.used[cur.key] = true;
  state.lastQ = { base: cur.q.value, golden: !!cur.golden, key: cur.key }; // remember meta so any team's verdict stays editable
  state.events.unshift({ title, team, at: new Date().toISOString(), question: cur.q.q || questionTitle(cur.q.type) });
  $('#resultTitle').textContent = title;
  $('#resultAnswer').textContent = answerText(cur.q);
  $('#resultNote').textContent = (cur.q.category==='crime'||cur.q.category==='rescue') ? '' : (cur.q.note || cur.q.evidence || '');
  renderVisual(cur.q,cur.c,'#resultVisual',{reveal:true}); // answer screen: reveal player photo etc.
  renderGoldenReveal();
  if(state.lastQ && state.lastQ.golden){ // secret golden tile just unmasked — sparkle + gold confetti
    sfx('golden', [20,40,20]);
    if(window.FX) window.FX.confetti({ count:90, colors:['#d7a018','#f0bd3e','#ffe08a','#fff4cf'] });
    if(Object.values(state.awards||{}).some(a=>a && a.state==='correct')) recordStats({ goldenHits:1 });
  }
  state.turn = other(cur.picker); // next pick alternates from who picked this one
  state.current = null;
  setupDecisionEditor();
  saveLocal();
  show('result');
}

// Let the host fix a mis-clicked verdict for EITHER team. A single question can
// score both teams (e.g. picker wrong -> other team steals), so the result
// screen offers an independent correct/wrong/none control per team.
function setupDecisionEditor(){
  const box = $('#decisionEdit'); if(!box) return;
  if(state.special){ box.classList.add('hidden'); box.innerHTML = ''; return; } // challenge/tiebreak score separately
  const base = state.lastQ ? state.lastQ.base : 0;
  const golden = !!(state.lastQ && state.lastQ.golden);
  const correctVal = base * (golden ? 2 : 1);
  const row = team => {
    const verdict = state.awards[team] ? state.awards[team].state : 'none';
    const act = v => v === verdict ? ' active' : '';
    return `<div class="de-row">
      <span class="de-label">قرار ${safe(state.teams[team].name)}:</span>
      <div class="de-btns">
        <button data-team="${team}" data-award="correct" class="success${act('correct')}">صحيحة (+${correctVal})</button>
        <button data-team="${team}" data-award="wrong" class="danger${act('wrong')}">خاطئة (−${base})</button>
        <button data-team="${team}" data-award="none"${act('none')}>بدون نقاط</button>
      </div>
    </div>`;
  };
  box.classList.remove('hidden');
  box.innerHTML = `<div class="de-title">تعديل القرارات إن وقع خطأ:</div>` + row('blue') + row('red');
  box.querySelectorAll('button[data-award]').forEach(b => b.onclick = () => editDecision(b.dataset.team, b.dataset.award));
}

function editDecision(team, target){ // team: 'blue'|'red'; target: 'correct'|'wrong'|'none'
  if(team !== 'blue' && team !== 'red') return;
  const current = state.awards[team] ? state.awards[team].state : 'none';
  if(target === current) return;
  setAward(team, target);
  setupDecisionEditor();
  renderGoldenReveal();
  refreshQScores();
  saveLocal();
  toast(`النتيجة: ${state.teams.blue.name} ${state.teams.blue.score} — ${state.teams.red.name} ${state.teams.red.score}`);
}

function next(){
  state.awards = {};
  state.lastQ = null;
  const de=$('#decisionEdit'); if(de){ de.classList.add('hidden'); de.innerHTML=''; }
  const gr=$('#goldenReveal'); if(gr) gr.classList.add('hidden');
  if(!remainingQuestions().length) return finishGame(); // board exhausted -> wrap up
  buildBoard();
  show('board');
}

// ---- end-game flows: comeback challenge + tiebreaker ----
function remainingQuestions(){
  const out=[];
  state.selected.forEach(slug=> qList(slug).slice(0,6).forEach(q=>{ const key=`${slug}:${q.ord}`; if(!state.used[key]) out.push({ slug, q, key }); }));
  return out;
}

function startChallenge(team){
  const rem = remainingQuestions();
  if(!rem.length) return concludeGame();
  rem.sort((a,b)=> b.q.value - a.q.value); // trailing team gets the highest-value question
  const pick = rem[0];
  toast('جولة التحدي لـ ' + state.teams[team].name + ' — أجب على سؤال عالي النقاط للعودة!');
  openQuestion(pick.slug, pick.q.ord, { mode:'challenge', answerer:team });
}

function finishChallenge(success){
  clearInterval(timerInt);
  const cur = state.current; if(!cur) return;
  state.used[cur.key] = true;
  const team = cur.answerer;
  if(success){
    const pts = cur.q.value * 2; // comeback boost
    state.teams[team].score += pts;
    toast(state.teams[team].name + ' عاد بقوة! +' + pts);
  } else {
    toast('لم تنجح جولة التحدي');
  }
  state.events.unshift({ title: success?'تحدٍّ ناجح':'تحدٍّ فاشل', team: success?team:null, at:new Date().toISOString(), question: cur.q.q || questionTitle(cur.q.type) });
  state.current=null; state.special=null;
  saveLocal();
  finishGame(); // re-evaluate: tie -> tiebreak, otherwise conclude
}

function startTiebreak(){
  const rem = remainingQuestions();
  if(!rem.length) return concludeGame(); // nothing left to break the tie — leave it a draw
  const pick = rem[Math.floor(Math.random()*rem.length)];
  toast('تعادل! سؤال الحسم — أول إجابة صحيحة تفوز');
  openQuestion(pick.slug, pick.q.ord, { mode:'tiebreak' });
}

function tiebreakWinner(team){
  clearInterval(timerInt);
  const cur = state.current; if(!cur) return;
  state.used[cur.key] = true;
  state.teams[team].score += cur.q.value; // the winning answer breaks the tie
  state.events.unshift({ title:'سؤال الحسم', team, at:new Date().toISOString(), question: cur.q.q || questionTitle(cur.q.type) });
  state.current=null; state.special=null;
  saveLocal();
  toast(state.teams[team].name + ' يفوز بسؤال الحسم!');
  concludeGame(team);
}

async function saveMatchRemote(match){
  if(SUPABASE){
    try{
      const { error } = await SUPABASE.from('matches').insert(match);
      if(!error) return true;
      console.warn(error);
    }catch(e){ console.warn(e); }
  }
  try{
    await api('/matches',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(match)});
    return true;
  }catch(e){ return false; }
}

function finishGame(){
  if(state.finished) return; // already concluded — never run the end-game sequence twice
  const b = state.teams.blue.score, r = state.teams.red.score;
  // 1) trailing team gets one comeback challenge, if questions remain
  if(!state.challengeDone && b !== r && remainingQuestions().length){
    state.challengeDone = true;
    return startChallenge(b < r ? 'blue' : 'red');
  }
  // 2) tie -> sudden-death question
  if(b === r && remainingQuestions().length){
    return startTiebreak();
  }
  // 3) otherwise wrap up
  return concludeGame();
}

// build a validated, sanitised match result (never trust the live score blindly)
function buildValidatedMatch(forcedWinner){
  const blue_name = sanitizeName(state.teams.blue.name, 'الفريق الأزرق');
  const red_name = sanitizeName(state.teams.red.name, 'الفريق الأحمر');
  const blue_score = clampScore(state.teams.blue.score);
  const red_score = clampScore(state.teams.red.score);
  let winner;
  if(forcedWinner === 'blue') winner = blue_name;
  else if(forcedWinner === 'red') winner = red_name;
  else winner = blue_score === red_score ? 'تعادل' : (blue_score > red_score ? blue_name : red_name);
  return { blue_name, red_name, blue_score, red_score, winner };
}

async function concludeGame(forcedWinner){
  if(state.matchSaved) return; // save-once guard: a completed match is recorded exactly once
  state.matchSaved = true;
  state.finished = true;        // match is over — no "continue" offered after this
  state.current = null;
  state.timerEndsAt = null;
  const match = buildValidatedMatch(forcedWinner);
  try{
    const rows = JSON.parse(localStorage.getItem('fakkir_leaderboard')||'[]');
    rows.push({...match, date: new Date().toISOString()});
    localStorage.setItem('fakkir_leaderboard', JSON.stringify(rows.slice(-100)));
  }catch(e){ /* corrupt/full local leaderboard — non-fatal */ }
  saveLocal();
  // grand finale: fanfare + confetti (draw gets a gentler cue, no confetti storm)
  const draw = match.winner === 'تعادل';
  if(draw){ sfx('lose'); }
  else {
    sfx('win', [60,30,60,30,120]);
    if(window.FX){
      const winColor = match.winner === match.blue_name ? '#1f7bff' : '#d83a45';
      window.FX.confetti({ count:220, colors:[winColor, '#d7a018', '#f0bd3e', '#ffffff'] });
      setTimeout(()=>window.FX.confetti({ count:120, colors:[winColor, '#d7a018'] }), 650);
    }
  }
  // lifetime stats: every concluded match counts; a decisive result counts as a win
  recordStats({ matchesPlayed:1, matchWins: draw ? 0 : 1 });
  checkAchievements();
  const remote = await saveMatchRemote(match);
  renderLeaderboard();
  show('leaderboard');
  toast(remote ? 'انتهت الجولة وتم حفظ النتيجة' : 'انتهت الجولة وتم حفظها محلياً');
}

// render one leaderboard row — winner escaped, scores coerced to integers (defence vs tampered data)
function leaderRow(i, winner, blueScore, redScore){
  const bs = Math.trunc(Number(blueScore) || 0), rs = Math.trunc(Number(redScore) || 0);
  return `<div class="leader-row"><b>${i+1}. ${safe(winner)}</b><span>${bs} - ${rs}</span></div>`;
}
// top-level leaderboard: render both tabs
function renderLeaderboard(){ renderTeamLeaderboard(); renderBlitzLeaderboard(); }

async function renderTeamLeaderboard(){
  const box = $('#leaderRows'); if(!box) return;
  let localRows = [];
  try{ localRows = JSON.parse(localStorage.getItem('fakkir_leaderboard')||'[]'); }catch(e){ localRows = []; }
  if(!Array.isArray(localRows)) localRows = [];
  localRows = localRows.slice().reverse();
  if(SUPABASE){
    try{
      const { data, error } = await SUPABASE.from('matches').select('winner,blue_score,red_score,created_at').order('created_at', { ascending:false }).limit(20);
      if(!error && data){
        box.innerHTML = data.length ? data.map((r,i)=>leaderRow(i, r.winner, r.blue_score, r.red_score)).join('') : '<p>لا توجد نتائج بعد.</p>';
        return;
      }
    }catch(e){ console.warn(e); }
  }
  box.innerHTML = localRows.length ? localRows.map((r,i)=>leaderRow(i, r.winner, r.blue_score ?? r.blue, r.red_score ?? r.red)).join('') : '<p>لا توجد نتائج بعد.</p>';
}

const MEDALS = ['🥇','🥈','🥉'];
// one ranked Blitz row; highlights the signed-in player's own entry
function blitzRow(i, r){
  const me = isLoggedIn() && r.user_id === USER.id;
  const rank = MEDALS[i] || `${i+1}`;
  const acc = r.answered > 0 ? Math.round((r.correct / r.answered) * 100) : 0;
  return `<div class="lb-row${me?' me':''}">`
    + `<span class="lb-rank">${rank}</span>`
    + `<span class="lb-name">${safe(r.player_name)}${me?' <small>(أنت)</small>':''}</span>`
    + `<span class="lb-meta">${acc}% · 🔥${Math.trunc(Number(r.max_streak)||0)}</span>`
    + `<b class="lb-score">${Math.trunc(Number(r.score)||0)}</b></div>`;
}

// reduce raw rows to the single best run per player, ranked high→low
function bestPerUser(rows){
  const best = new Map();
  for(const r of (rows||[])){ const cur = best.get(r.user_id); if(!cur || r.score > cur.score) best.set(r.user_id, r); }
  return [...best.values()].sort((a,b)=> b.score - a.score);
}

// ranked best-score-per-player board; honors the version filter ('all' uses the view)
async function renderBlitzLeaderboard(){
  const box = $('#blitzLeaderRows'); if(!box) return;
  if(!SUPABASE){ box.innerHTML = '<p class="lb-empty">لوحة المتصدرين تحتاج اتصالاً بالإنترنت.</p>'; return; }
  box.innerHTML = '<p class="lb-empty">جارٍ التحميل...</p>';
  try{
    let rows;
    if(blitzLbFilter === 'all'){
      const { data, error } = await SUPABASE.from('blitz_leaderboard')
        .select('user_id,player_name,score,correct,answered,max_streak')
        .order('score', { ascending:false }).limit(50);
      if(error) throw error;
      rows = data || [];
    } else {
      // per-version: rank best run per player within the chosen version
      const { data, error } = await SUPABASE.from('blitz_scores')
        .select('user_id,player_name,score,correct,answered,max_streak')
        .eq('version', Number(blitzLbFilter)).order('score', { ascending:false }).limit(400);
      if(error) throw error;
      rows = bestPerUser(data).slice(0, 50);
    }
    if(!rows.length){ box.innerHTML = '<p class="lb-empty">لا نتائج بعد — كن أول المتصدرين! ⚡</p>'; return; }
    box.innerHTML = rows.map((r,i)=>blitzRow(i, r)).join('');
  }catch(e){ box.innerHTML = '<p class="lb-empty">تعذّر تحميل المتصدرين.</p>'; }
}

// fill the leaderboard version filter (كل النسخ + each version)
function populateBlitzLbVersions(){
  const sel = $('#blitzLbVersion'); if(!sel || !DATA) return;
  const versions = [...new Set(DATA.questions.map(q=>q.version))].sort((a,b)=>a-b);
  sel.innerHTML = `<option value="all">كل النسخ</option>` + versions.map(v=>`<option value="${v}">النسخة ${verLetter(v)}</option>`).join('');
  sel.value = blitzLbFilter;
  sel.onchange = ()=>{ blitzLbFilter = sel.value; renderBlitzLeaderboard(); };
}

// switch leaderboard tabs (blitz | teams)
function showLbTab(which){
  const blitz = which !== 'teams';
  $('#lbBlitz').classList.toggle('hidden', !blitz);
  $('#lbTeams').classList.toggle('hidden', blitz);
  $$('.lb-tab').forEach(b=> b.classList.toggle('active', b.dataset.lb === (blitz?'blitz':'teams')));
  if(blitz) renderBlitzLeaderboard(); else renderTeamLeaderboard();
}
function resetLocal(){
  if(!askConfirm('مسح جميع النتائج والمباراة المحفوظة محليًا؟ لا يمكن التراجع.')) return; // confirm before clearing
  try{ localStorage.removeItem('fakkir_leaderboard'); localStorage.removeItem('fakkir_state_v2'); }catch(e){}
  state.finished = true; // current local match no longer "active"
  renderLeaderboard();
  updateResumeUI();
  toast('تم المسح');
}

function bind(){
  $$('[data-screen]').forEach(b=>b.onclick=()=>show(b.dataset.screen));
  $('#startBtn').onclick=startNewMatch;
  const cmb=$('#continueMatchBtn'); if(cmb) cmb.onclick=continueMatch;
  const nmb=$('#newMatchBtn'); if(nmb) nmb.onclick=startNewMatch;
  $('#randomCats').onclick=randomCats;
  $('#clearCats').onclick=clearCats;
  $('#goBoard').onclick=()=>{ buildBoard(); show('board'); };
  $('#finishGame').onclick=finishGame;
  $('#correctBtn').onclick=correctAnswer;
  $('#wrongBtn').onclick=()=>wrongAnswer(); // no reason: don't pass the click event as a toast string
  $('#passBtn').onclick=passQuestion;
  $('#showAnswerBtn').onclick=showAnswer;
  $('#nextBtn').onclick=next;
  const tbB=$('#tbBlueBtn'); if(tbB) tbB.onclick=()=>tiebreakWinner('blue');
  const tbR=$('#tbRedBtn'); if(tbR) tbR.onclick=()=>tiebreakWinner('red');
  // decision-editor buttons are rebuilt per result by setupDecisionEditor(), which wires their clicks
  $('#themeToggle').onclick=()=>{
    const n=document.body.dataset.theme==='dark'?'light':'dark';
    document.body.dataset.theme=n;
    localStorage.setItem('theme',n);
    renderHeader();
  };
  $('#resetLocal').onclick=resetLocal;
  $('#timerSetting').onchange=e=>{ state.settings.timer = Number(e.target.value); saveLocal(); };
  const navToggle=$('#navToggle'), mainNav=$('#mainNav');
  if(navToggle && mainNav) navToggle.onclick=()=>{ const open=mainNav.classList.toggle('open'); navToggle.classList.toggle('open',open); navToggle.setAttribute('aria-expanded',String(open)); };
  const ddBtn=$('#versionDDBtn');
  if(ddBtn) ddBtn.onclick=e=>{ e.stopPropagation(); const dd=$('#versionDD'); const open=dd.classList.toggle('open'); ddBtn.setAttribute('aria-expanded',String(open)); };
  document.addEventListener('click', e=>{ const dd=$('#versionDD'); if(dd && dd.classList.contains('open') && !dd.contains(e.target)) closeVersionDD(); });
  const soundToggle=$('#soundToggle');
  if(soundToggle){ updateSoundIcon(); soundToggle.onclick=()=>{ state.settings.sound=!state.settings.sound; saveLocal(); updateSoundIcon(); if(state.settings.sound) sfx('select'); }; }
  // solo Blitz mode + achievements
  $$('.js-blitz').forEach(b=> b.onclick = startBlitz);
  const bR=$('#blitzReveal'); if(bR) bR.onclick=blitzReveal;
  const bG=$('#blitzGood'); if(bG) bG.onclick=()=>blitzMark(true);
  const bB=$('#blitzBad'); if(bB) bB.onclick=()=>blitzMark(false);
  const bQ=$('#blitzQuit'); if(bQ) bQ.onclick=quitBlitz;
  // auth: form submit, sign-in/up toggle, settings account button
  const af=$('#authForm'); if(af) af.onsubmit=submitAuth;
  const atb=$('#authToggleBtn'); if(atb) atb.onclick=()=>setAuthMode(authMode==='signup'?'signin':'signup');
  const acr=$('#accountRow'); if(acr) acr.onclick=accountAction;
  const ha=$('#haAction'); if(ha) ha.onclick=accountAction;
  const al=$('#adminLink'); if(al) al.onclick=()=>{ location.href='admin.html'; };
  // profile screen actions
  const plb=$('#profileLoginBtn'); if(plb) plb.onclick=()=>openAuth('سجّل الدخول لعرض ملفّك.');
  const psn=$('#profileSaveName'); if(psn) psn.onclick=saveProfileName;
  const psp=$('#profileSavePass'); if(psp) psp.onclick=saveProfilePass;
  const pso=$('#profileSignout'); if(pso) pso.onclick=async()=>{ await signOut(); show('home'); };
  // settings controls: theme, sound, haptics
  const th=$('#themeSetting'); if(th) th.onchange=e=>setThemePref(e.target.value);
  const sd=$('#soundSetting'); if(sd) sd.onchange=e=>{ state.settings.sound=!!e.target.checked; saveLocal(); updateSoundIcon(); if(state.settings.sound) sfx('select'); };
  const hp=$('#hapticSetting'); if(hp) hp.onchange=e=>{ state.settings.haptics=!!e.target.checked; saveLocal(); if(state.settings.haptics) fxHaptic(20); };
  // leaderboard tabs
  $$('.lb-tab').forEach(b=> b.onclick=()=>showLbTab(b.dataset.lb));
  // follow the device theme live until the player makes an explicit choice
  try{ matchMedia('(prefers-color-scheme: dark)').addEventListener('change', ()=>{ if(!localStorage.getItem('theme')) renderHeader(); }); }catch(e){}
  // logo fallback without an inline onerror handler (CSP forbids inline scripts)
  $$('.brand-logo').forEach(img=>{
    const fix=()=>{ if(img.dataset.fb) return; img.dataset.fb='1'; img.src='assets/img/ui/logo.png'; };
    img.addEventListener('error', fix, { once:true });
    if(img.complete && img.naturalWidth === 0) fix();
  });
}

const verLetter = n => String.fromCharCode(64 + n); // 1 -> A ... 15 -> O

function beep(freq, dur, type){
  if(!state.settings.sound) return;
  // route through the premium FX engine when present (richer, shared mixer)
  if(window.FX){ window.FX.tone(freq, 0, dur, type); return; }
  try{
    _audio = _audio || new (window.AudioContext || window.webkitAudioContext)();
    if(_audio.state === 'suspended') _audio.resume();
    const o = _audio.createOscillator(), g = _audio.createGain(), t = _audio.currentTime;
    o.type = type || 'sine'; o.frequency.value = freq;
    o.connect(g); g.connect(_audio.destination);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.18, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.start(t); o.stop(t + dur + 0.02);
  }catch(e){}
}

// named premium SFX + light haptics; both respect the sound toggle
function sfx(name, vibe){
  if(!state.settings.sound){ if(vibe) fxHaptic(vibe); return; }
  if(window.FX) window.FX.sound(name);
  if(vibe) fxHaptic(vibe);
}
function fxHaptic(pattern){ if(window.FX && state.settings && state.settings.haptics !== false) window.FX.haptic(pattern); }
function updateSoundIcon(){
  if(window.FX) window.FX.setEnabled(!!state.settings.sound); // keep the FX mixer in sync with the toggle
  const b = $('#soundToggle'); if(!b) return;
  b.classList.toggle('muted', !state.settings.sound);
  const l = $('#soundLabel'); if(l) l.textContent = state.settings.sound ? 'الصوت' : 'صامت';
}

function setVersion(v){
  state.settings.version = Number(v);
  saveLocal();
  $$('.version-select').forEach(s=>{ s.value = state.settings.version; });
  const cur = $('#versionDDBtn .vp-dd-current'); if(cur) cur.textContent = 'النسخة ' + verLetter(state.settings.version);
  $$('#versionDDList .vp-dd-opt').forEach(li=> li.setAttribute('aria-selected', String(Number(li.dataset.v) === state.settings.version)));
  renderCategories();
}
function closeVersionDD(){ const dd=$('#versionDD'); if(dd) dd.classList.remove('open'); const b=$('#versionDDBtn'); if(b) b.setAttribute('aria-expanded','false'); }

function populateVersions(){
  if(!DATA) return;
  const versions = [...new Set(DATA.questions.map(q=>q.version))].sort((a,b)=>a-b);
  if(!versions.includes(state.settings.version)) state.settings.version = versions[0] || 1;
  const opts = versions.map(v=>`<option value="${v}">النسخة ${verLetter(v)}</option>`).join('');
  $$('.version-select').forEach(sel=>{ sel.innerHTML = opts; sel.value = state.settings.version; sel.onchange = e=>setVersion(e.target.value); });
  const list = $('#versionDDList');
  if(list){
    list.innerHTML = versions.map(v=>`<li class="vp-dd-opt" role="option" data-v="${v}" aria-selected="${v===state.settings.version}">النسخة ${verLetter(v)}</li>`).join('');
    list.querySelectorAll('.vp-dd-opt').forEach(li=> li.onclick=()=>{ setVersion(li.dataset.v); closeVersionDD(); });
  }
  const cur = $('#versionDDBtn .vp-dd-current'); if(cur) cur.textContent = 'النسخة ' + verLetter(state.settings.version);
  populateBlitzLbVersions(); // keep the Blitz leaderboard version filter in sync
}

/* ===================== Authentication (email + password via Supabase) ===================== */
// display name for the leaderboard: chosen name, else the email's local part
function userName(){
  const meta = USER && USER.user_metadata;
  const n = meta && (meta.name || meta.full_name);
  if(n) return sanitizeName(n, 'لاعب');
  if(USER && USER.email) return sanitizeName(USER.email.split('@')[0], 'لاعب');
  return 'لاعب';
}
const isLoggedIn = () => !!USER;
// is the signed-in account an admin? (declared in config; enforced by DB RLS)
function isAdmin(){
  if(!isLoggedIn() || !USER.email) return false;
  const list = Array.isArray(CONFIG.adminEmails) ? CONFIG.adminEmails.map(e=>String(e).toLowerCase()) : [];
  return list.includes(String(USER.email).toLowerCase());
}

// read the current session and keep the UI in sync; called on load + auth changes
async function refreshSession(){
  if(!SUPABASE){ USER = null; updateAuthUI(); return; }
  try{ const { data } = await SUPABASE.auth.getSession(); USER = (data && data.session && data.session.user) || null; }
  catch(e){ USER = null; }
  updateAuthUI();
}

// initials + a stable color for an avatar from a name
function avatarText(name){ return (String(name||'?').trim().slice(0,2) || '?'); }
function avatarColor(seed){
  let h = 0; for(const c of String(seed||'x')) h = (h*31 + c.charCodeAt(0)) >>> 0;
  return `linear-gradient(180deg,hsl(${h%360} 70% 52%),hsl(${(h%360+24)%360} 70% 42%))`;
}

// reflect login state in the settings "account" row, profile nav, and home chip
function updateAuthUI(){
  const inOk = isLoggedIn();
  const nameEl = $('#accountName'), subEl = $('#accountSub'), btn = $('#accountBtn');
  if(nameEl) nameEl.textContent = inOk ? userName() : 'زائر';
  if(subEl) subEl.textContent = inOk ? (USER.email || 'مسجّل الدخول') : 'غير مسجّل الدخول';
  if(btn) btn.textContent = inOk ? 'الملف الشخصي ›' : 'تسجيل الدخول';
  const av = $('#accountAvatar');
  if(av){
    if(inOk){ av.textContent = avatarText(userName()); av.style.background = avatarColor(userName()); av.style.color = '#fff'; av.classList.add('has-initials'); }
    else { av.classList.remove('has-initials'); av.style.background = ''; av.style.color = ''; }
  }
  const np = $('#navProfile'); if(np) np.classList.toggle('hidden', !inOk); // profile nav only when logged in
  const al = $('#adminLink'); if(al) al.classList.toggle('hidden', !isAdmin()); // admin entry point in settings
  refreshHomeChip();
}

// compact account chip on the home screen: login state + best score + live rank
async function refreshHomeChip(){
  const box = $('#homeAccount'); if(!box) return;
  const nameEl = $('#haName'), subEl = $('#haSub'), act = $('#haAction');
  if(!isLoggedIn()){
    box.dataset.state = 'out';
    if(nameEl) nameEl.textContent = 'زائر';
    if(subEl) subEl.textContent = 'سجّل الدخول للعب التحدي السريع';
    if(act) act.textContent = 'تسجيل الدخول';
    return;
  }
  box.dataset.state = 'in';
  if(nameEl) nameEl.textContent = userName();
  if(act) act.textContent = 'ملفّي';
  const best = Number(loadStats().blitzBest) || 0;
  if(subEl) subEl.textContent = best ? ('أفضل نتيجة: ' + best) : 'العب أول تحدٍّ سريع!';
  // enrich with the player's live global rank when the leaderboard is reachable
  const rank = await myBlitzRank();
  if(rank && subEl) subEl.textContent = `أفضل: ${rank.score} · المركز #${rank.pos} من ${rank.total}`;
}

// the signed-in player's best-score rank across all versions, or null
async function myBlitzRank(){
  if(!SUPABASE || !isLoggedIn()) return null;
  try{
    const { data, error } = await SUPABASE.from('blitz_leaderboard')
      .select('user_id,score').order('score', { ascending:false }).limit(1000);
    if(error || !data) return null;
    const pos = data.findIndex(r => r.user_id === USER.id);
    return pos >= 0 ? { pos: pos + 1, total: data.length, score: data[pos].score } : null;
  }catch(e){ return null; }
}

// open the login screen, optionally with a custom intro + an action to resume after success
function openAuth(intro, after){
  pendingAfterAuth = after || null;
  if(intro){ const el = $('#authIntro'); if(el) el.textContent = intro; }
  setAuthMode('signin');
  const err = $('#authError'); if(err) err.textContent = '';
  show('auth');
  setTimeout(()=>{ const e = $('#authEmail'); if(e) e.focus(); }, 60);
}

// toggle the form between sign-in and sign-up
function setAuthMode(mode){
  authMode = mode === 'signup' ? 'signup' : 'signin';
  const signup = authMode === 'signup';
  const t = $('#authTitle'); if(t) t.textContent = signup ? 'إنشاء حساب' : 'تسجيل الدخول';
  const sub = $('#authSubmit'); if(sub) sub.textContent = signup ? 'إنشاء حساب' : 'دخول';
  const nameWrap = $('#authNameWrap'); if(nameWrap) nameWrap.classList.toggle('hidden', !signup);
  const tg = $('#authToggleText'); if(tg) tg.textContent = signup ? 'لديك حساب بالفعل؟' : 'ليس لديك حساب؟';
  const tb = $('#authToggleBtn'); if(tb) tb.textContent = signup ? 'سجّل الدخول' : 'أنشئ حساباً';
  const pass = $('#authPass'); if(pass) pass.setAttribute('autocomplete', signup ? 'new-password' : 'current-password');
  const err = $('#authError'); if(err) err.textContent = '';
}

function authError(msg){ const el = $('#authError'); if(el) el.textContent = msg; sfx('wrong'); }

// handle the auth form submit (sign in or sign up)
async function submitAuth(e){
  if(e) e.preventDefault();
  if(!SUPABASE) return authError('تسجيل الدخول غير متاح الآن — تحقق من الاتصال.');
  const email = ($('#authEmail').value || '').trim();
  const pass = $('#authPass').value || '';
  const name = sanitizeName($('#authName').value, '') || (email ? email.split('@')[0] : '');
  if(!email || pass.length < 6) return authError('أدخل بريداً صحيحاً وكلمة مرور من ٦ أحرف على الأقل.');
  const btn = $('#authSubmit'); if(btn){ btn.disabled = true; btn.textContent = '...'; }
  try{
    if(authMode === 'signup'){
      const { data, error } = await SUPABASE.auth.signUp({ email, password: pass, options:{ data:{ name } } });
      if(error) return authError(authMsg(error));
      if(!data.session){ // email confirmation is ON → no session yet
        toast('تم إنشاء الحساب — افحص بريدك لتأكيد الحساب ثم سجّل الدخول.');
        setAuthMode('signin');
        return;
      }
      USER = data.user;
    } else {
      const { data, error } = await SUPABASE.auth.signInWithPassword({ email, password: pass });
      if(error) return authError(authMsg(error));
      USER = data.user;
    }
    onAuthSuccess();
  }catch(err){ authError('تعذّر تسجيل الدخول، حاول مجدداً.'); }
  finally{ if(btn){ btn.disabled = false; setAuthMode(authMode); } }
}

// friendly Arabic messages for the common auth errors
function authMsg(error){
  const m = (error && error.message || '').toLowerCase();
  if(m.includes('already registered') || m.includes('already exists')) return 'هذا البريد مسجّل بالفعل — سجّل الدخول.';
  if(m.includes('invalid login')) return 'البريد أو كلمة المرور غير صحيحة.';
  if(m.includes('email not confirmed')) return 'لم يتم تأكيد البريد بعد — افحص بريدك.';
  if(m.includes('password')) return 'كلمة المرور ضعيفة جداً (٦ أحرف على الأقل).';
  return error && error.message ? error.message : 'حدث خطأ، حاول مجدداً.';
}

function onAuthSuccess(){
  updateAuthUI();
  sfx('correct'); if(window.FX) window.FX.confetti({ count:90 });
  toast('مرحباً ' + userName() + '!');
  const after = pendingAfterAuth; pendingAfterAuth = null;
  if(after === 'blitz') return startBlitz();
  show('home');
}

async function signOut(){
  if(SUPABASE){ try{ await SUPABASE.auth.signOut(); }catch(e){} }
  USER = null;
  updateAuthUI();
  toast('تم تسجيل الخروج');
  renderBlitzLeaderboard();
}

// settings "account" button: log in or out depending on state
// account chip / settings row: open the profile when logged in, else the login screen
function accountAction(){ if(isLoggedIn()) show('profile'); else openAuth('سجّل الدخول لحفظ نتائجك في لوحة المتصدرين.'); }

/* ===================== Profile ===================== */
async function renderProfile(){
  const guest = $('#profileGuest'), body = $('#profileBody');
  if(!guest || !body) return;
  const inOk = isLoggedIn();
  guest.classList.toggle('hidden', inOk);
  body.classList.toggle('hidden', !inOk);
  if(!inOk) return;
  const name = userName();
  $('#profileName').textContent = name;
  $('#profileEmail').textContent = USER.email || '';
  const av = $('#profileAvatar'); av.textContent = avatarText(name); av.style.background = avatarColor(name);
  $('#profileNameInput').value = name;
  $('#profileNameMsg').textContent = ''; $('#profilePassMsg').textContent = ''; $('#profilePass').value = '';
  // lifetime stats + achievements
  const s = loadStats(), ach = unlockedSet().size;
  const stat = (v, l) => `<div class="pstat"><b>${safe(v)}</b><span>${safe(l)}</span></div>`;
  $('#profileStats').innerHTML =
    stat(Number(s.blitzBest)||0, 'أفضل نتيجة سريعة') +
    stat(Number(s.bestStreak)||0, 'أطول سلسلة') +
    stat(Number(s.matchWins)||0, 'انتصارات') +
    stat(Number(s.matchesPlayed)||0, 'مباريات') +
    stat(Number(s.blitzGames)||0, 'تحديات سريعة') +
    stat(ach + '/' + ACHIEVEMENTS.length, 'إنجازات');
  // live global Blitz rank
  const re = $('#profileRank'); re.classList.add('hidden');
  const r = await myBlitzRank();
  if(r){ re.textContent = `🏆 المركز #${r.pos} من ${r.total} عالمياً`; re.classList.remove('hidden'); }
}

async function saveProfileName(){
  const msg = $('#profileNameMsg'); const name = sanitizeName($('#profileNameInput').value, '');
  if(!name){ msg.textContent = 'أدخل اسماً صحيحاً.'; return; }
  if(!SUPABASE || !isLoggedIn()){ msg.textContent = 'يجب تسجيل الدخول.'; return; }
  msg.textContent = 'جارٍ الحفظ…';
  try{
    const { data, error } = await SUPABASE.auth.updateUser({ data:{ name } });
    if(error){ msg.textContent = 'تعذّر الحفظ: ' + error.message; return; }
    USER = data.user; updateAuthUI(); renderProfile();
    msg.textContent = 'تم الحفظ ✓'; sfx('correct');
  }catch(e){ msg.textContent = 'خطأ، حاول مجدداً.'; }
}

async function saveProfilePass(){
  const msg = $('#profilePassMsg'); const p = $('#profilePass').value || '';
  if(p.length < 6){ msg.textContent = 'كلمة المرور ٦ أحرف على الأقل.'; return; }
  if(!SUPABASE){ msg.textContent = 'غير متاح الآن.'; return; }
  msg.textContent = 'جارٍ التحديث…';
  try{
    const { error } = await SUPABASE.auth.updateUser({ password: p });
    if(error){ msg.textContent = 'تعذّر: ' + error.message; return; }
    $('#profilePass').value = ''; msg.textContent = 'تم تحديث كلمة المرور ✓'; sfx('correct');
  }catch(e){ msg.textContent = 'خطأ، حاول مجدداً.'; }
}

/* ===================== Settings controls ===================== */
const currentThemePref = () => { const s = localStorage.getItem('theme'); return (s==='light'||s==='dark') ? s : 'auto'; };
function setThemePref(v){
  if(v==='light'||v==='dark') localStorage.setItem('theme', v);
  else { try{ localStorage.removeItem('theme'); }catch(e){} } // auto = follow device
  renderHeader();
}
// reflect current preferences in the Settings controls when the screen opens
function syncSettingsControls(){
  const ts = $('#timerSetting'); if(ts) ts.value = String(state.settings.timer || 15);
  const th = $('#themeSetting'); if(th) th.value = currentThemePref();
  const sd = $('#soundSetting'); if(sd) sd.checked = state.settings.sound !== false;
  const hp = $('#hapticSetting'); if(hp) hp.checked = state.settings.haptics !== false;
}

/* ===================== Solo Blitz mode (isolated from the team engine) ===================== */
const BLITZ_SECONDS = 60;
const blitz = { active:false, score:0, streak:0, maxStreak:0, qs:[], i:0, endsAt:0, revealed:false, answered:0, correct:0 };
let blitzInt = null, blitzLastSec = -1;

function blitzBest(){ try{ return Math.max(0, Math.trunc(Number(localStorage.getItem('fakkir_blitz_best'))||0)); }catch(e){ return 0; } }
function setBlitzBest(v){ try{ localStorage.setItem('fakkir_blitz_best', String(Math.trunc(v))); }catch(e){} }

// every answerable question in the chosen version (needs a prompt and an answer)
function blitzPool(){
  const v = state.settings.version;
  return DATA.questions.filter(q => q.version===v && (q.q || q.type) && q.a);
}

function startBlitz(){
  if(!DATA){ return toast('جارٍ تحميل البيانات...'); }
  // login required: results are saved to the shared leaderboard
  if(!isLoggedIn()) return openAuth('سجّل الدخول لتلعب التحدي السريع وتُسجَّل نتيجتك في لوحة المتصدرين.', 'blitz');
  const pool = blitzPool();
  if(!pool.length) return toast('لا توجد أسئلة متاحة لهذه النسخة');
  // progress from easiest to hardest: sort by point value ascending, random within each tier
  blitz.qs = pool.slice().sort((a,b)=> (Number(a.value)||0) - (Number(b.value)||0) || (Math.random()-0.5));
  blitz.active = true; blitz.score = 0; blitz.streak = 0; blitz.maxStreak = 0;
  blitz.i = 0; blitz.answered = 0; blitz.correct = 0; blitz.revealed = false;
  blitz.endsAt = Date.now() + BLITZ_SECONDS*1000;
  sfx('start', 20);
  renderBlitzQuestion();
  show('blitz');
  startBlitzTimer();
}

function startBlitzTimer(){
  clearInterval(blitzInt); blitzLastSec = -1;
  blitzInt = setInterval(()=>{
    const left = Math.max(0, Math.ceil((blitz.endsAt - Date.now())/1000));
    if(left !== blitzLastSec){
      blitzLastSec = left;
      const el = $('#blitzTime'); if(el){ el.textContent = left; el.classList.toggle('urgent', left<=5 && left>0); }
      if(left<=5 && left>0){ sfx('tick'); fxHaptic(15); }
    }
    if(left<=0){ clearInterval(blitzInt); endBlitz(); }
  }, 200);
}

function renderBlitzQuestion(){
  if(blitz.i >= blitz.qs.length) return endBlitz(); // exhausted the pool before the clock
  blitz.revealed = false;
  const q = blitz.qs[blitz.i];
  const c = cat(q.category) || { name:'', image:'' };
  $('#blitzScore').textContent = blitz.score;
  $('#blitzStreak').textContent = blitz.streak;
  $('#blitzCat').textContent = c.name || '';
  $('#blitzQ').textContent = q.q || questionTitle(q.type);
  const story = (q.category==='crime' || q.category==='rescue') ? (q.note||'') : '';
  const bs = $('#blitzStory'); if(bs){ bs.textContent = story; bs.classList.toggle('hidden', !story); }
  renderVisual(q, c, '#blitzVisual');
  const ab = $('#blitzAnswer'); ab.classList.add('hidden'); ab.textContent = '';
  $('#blitzReveal').classList.remove('hidden');
  $('#blitzGood').classList.add('hidden');
  $('#blitzBad').classList.add('hidden');
}

function blitzReveal(){
  const q = blitz.qs[blitz.i];
  if(!q || blitz.revealed || !blitz.active) return;
  blitz.revealed = true;
  const c = cat(q.category) || { name:'', image:'' };
  const scenario = q.category==='crime' || q.category==='rescue';
  $('#blitzAnswer').textContent = answerText(q) + (!scenario && q.note ? ` — ${q.note}` : '');
  $('#blitzAnswer').classList.remove('hidden');
  if(q.image) renderVisual(q, c, '#blitzVisual', { reveal:true });
  $('#blitzReveal').classList.add('hidden');
  $('#blitzGood').classList.remove('hidden');
  $('#blitzBad').classList.remove('hidden');
  sfx('click');
}

function blitzMark(ok){
  if(!blitz.active) return;
  blitz.answered++;
  if(ok){
    blitz.correct++;
    blitz.streak++; blitz.maxStreak = Math.max(blitz.maxStreak, blitz.streak);
    const pts = 100 + (blitz.streak-1)*25; // streak combo bonus
    blitz.score += pts;
    sfx('correct', 20);
    toast(`+${pts}${blitz.streak>=3 ? `  🔥 ×${blitz.streak}` : ''}`);
  } else {
    blitz.streak = 0;
    sfx('wrong', [30,30]);
  }
  $('#blitzScore').textContent = blitz.score;
  $('#blitzStreak').textContent = blitz.streak;
  if(window.FX) window.FX.pop($('#blitzScore'));
  blitz.i++;
  if(blitz.active && Date.now() < blitz.endsAt) renderBlitzQuestion(); // else the timer's endBlitz wraps up
}

function endBlitz(){
  if(!blitz.active) return; // idempotent: timer + pool-exhaustion can both call this
  blitz.active = false;
  clearInterval(blitzInt);
  const prevBest = blitzBest();
  const isBest = blitz.score > prevBest;
  if(isBest) setBlitzBest(blitz.score);
  recordStats({ blitzGames:1, blitzCorrect:blitz.correct, blitzBest: isBest ? blitz.score : null, maxStreak: blitz.maxStreak });
  const rk = $('#blitzRank'); if(rk){ rk.classList.add('hidden'); rk.textContent = ''; } // reset; filled after the score saves
  $('#blitzFinalScore').textContent = blitz.score;
  $('#blitzBest').textContent = Math.max(prevBest, blitz.score);
  $('#blitzSummary').textContent = `أجبت ${blitz.answered} سؤالًا · ${blitz.correct} صحيحة · أطول سلسلة ${blitz.maxStreak}`;
  const badge = $('#blitzNewBest'); if(badge) badge.classList.toggle('hidden', !isBest);
  if(isBest){ sfx('win', [60,30,60]); if(window.FX) window.FX.confetti({ count:200 }); }
  else sfx('lose');
  checkAchievements();
  show('blitzResult');
  submitBlitzScore(); // record this run on the shared leaderboard (fire-and-forget)
}

// persist a finished Blitz run to the Supabase leaderboard (requires login)
async function submitBlitzScore(){
  if(!SUPABASE || !isLoggedIn()) return;
  try{
    const { error } = await SUPABASE.from('blitz_scores').insert({
      user_id: USER.id,
      player_name: userName(),
      score: clampScore(blitz.score),
      correct: Math.max(0, Math.trunc(blitz.correct)),
      answered: Math.max(0, Math.trunc(blitz.answered)),
      max_streak: Math.max(0, Math.trunc(blitz.maxStreak)),
      version: Number(state.settings.version) || 1
    });
    if(error){ console.warn('blitz score save failed', error); return; }
    renderBlitzLeaderboard();
    refreshHomeChip();
    // reveal the player's new global rank on the result screen
    const rank = await myBlitzRank();
    const el = $('#blitzRank');
    if(el && rank){
      el.textContent = rank.pos <= 3 ? `🏆 المركز #${rank.pos} عالمياً!` : `مركزك: #${rank.pos} من ${rank.total}`;
      el.classList.remove('hidden');
      if(rank.pos === 1) sfx('golden');
    }
  }catch(e){ console.warn(e); }
}

function quitBlitz(){ blitz.active = false; clearInterval(blitzInt); show('home'); }

/* ===================== Lifetime stats + achievements ===================== */
function loadStats(){
  try{ const s = JSON.parse(localStorage.getItem('fakkir_stats')||'{}'); return (s && typeof s==='object' && !Array.isArray(s)) ? s : {}; }
  catch(e){ return {}; }
}
function saveStats(s){ try{ localStorage.setItem('fakkir_stats', JSON.stringify(s)); }catch(e){} }
function recordStats(delta){
  const s = loadStats();
  const add = k => { s[k] = (Number(s[k])||0) + (Number(delta[k])||0); };
  ['blitzGames','blitzCorrect','matchesPlayed','matchWins','goldenHits'].forEach(k => { if(delta[k]) add(k); });
  if(delta.blitzBest != null) s.blitzBest = Math.max(Number(s.blitzBest)||0, delta.blitzBest);
  if(delta.maxStreak != null) s.bestStreak = Math.max(Number(s.bestStreak)||0, delta.maxStreak);
  saveStats(s);
}

const ACHIEVEMENTS = [
  { id:'first_blitz', icon:'⚡', name:'انطلاقة',        desc:'أكمل أول تحدٍّ سريع',                 test:s=>(s.blitzGames||0)>=1 },
  { id:'blitz_1000',  icon:'🚀', name:'سريع البديهة',   desc:'سجّل 1000 نقطة في تحدٍّ سريع',         test:s=>(s.blitzBest||0)>=1000 },
  { id:'blitz_2500',  icon:'🌟', name:'أسطورة السرعة',  desc:'سجّل 2500 نقطة في تحدٍّ سريع',         test:s=>(s.blitzBest||0)>=2500 },
  { id:'streak_5',    icon:'🔥', name:'سلسلة ملتهبة',   desc:'حقّق سلسلة من 5 إجابات صحيحة',         test:s=>(s.bestStreak||0)>=5 },
  { id:'streak_10',   icon:'💥', name:'لا يُوقَف',       desc:'حقّق سلسلة من 10 إجابات صحيحة',        test:s=>(s.bestStreak||0)>=10 },
  { id:'correct_50',  icon:'🎯', name:'خمسون إصابة',    desc:'أجب 50 سؤالًا صحيحًا في الوضع السريع', test:s=>(s.blitzCorrect||0)>=50 },
  { id:'first_win',   icon:'🏆', name:'أول انتصار',     desc:'افز بمباراة فريقين',                  test:s=>(s.matchWins||0)>=1 },
  { id:'golden',      icon:'⭐', name:'لمسة ذهبية',      desc:'أجب على سؤال ذهبي بنجاح',             test:s=>(s.goldenHits||0)>=1 },
  { id:'veteran',     icon:'🎖️', name:'محترف',          desc:'العب 10 مباريات فريقين',              test:s=>(s.matchesPlayed||0)>=10 },
];
function unlockedSet(){ try{ const a = JSON.parse(localStorage.getItem('fakkir_achievements')||'[]'); return new Set(Array.isArray(a)?a:[]); }catch(e){ return new Set(); } }
function saveUnlocked(set){ try{ localStorage.setItem('fakkir_achievements', JSON.stringify([...set])); }catch(e){} }

// unlock any newly-earned achievements; toast + sparkle for fresh ones
function checkAchievements(){
  const s = loadStats(), set = unlockedSet(), fresh = [];
  ACHIEVEMENTS.forEach(a=>{ if(!set.has(a.id) && a.test(s)){ set.add(a.id); fresh.push(a); } });
  if(fresh.length){
    saveUnlocked(set);
    fresh.forEach((a,i)=> setTimeout(()=>{ toast(`${a.icon} إنجاز جديد: ${a.name}`); sfx('golden'); }, 600 + i*1100));
  }
  return fresh;
}

function renderAchievements(){
  const grid = $('#achGrid'); if(!grid) return;
  const s = loadStats(), set = unlockedSet();
  ACHIEVEMENTS.forEach(a=>{ if(!set.has(a.id) && a.test(s)) set.add(a.id); }); // reflect anything just earned
  saveUnlocked(set);
  grid.innerHTML = ACHIEVEMENTS.map(a=>{
    const on = set.has(a.id);
    return `<div class="ach${on?' on':''}"><span class="ach-ico">${on?a.icon:'🔒'}</span><b>${safe(a.name)}</b><small>${safe(a.desc)}</small></div>`;
  }).join('');
  const st = $('#achStats');
  if(st) st.innerHTML =
    `<span><b>${Number(s.blitzBest)||0}</b>أفضل نتيجة سريعة</span>` +
    `<span><b>${Number(s.bestStreak)||0}</b>أطول سلسلة</span>` +
    `<span><b>${Number(s.matchWins)||0}</b>انتصارات</span>` +
    `<span><b>${set.size}/${ACHIEVEMENTS.length}</b>إنجازات</span>`;
}

// stable per-browser id so the admin can tell returning visitors from new ones
function sessionId(){
  let id = '';
  try{ id = localStorage.getItem('fakkir_sid') || ''; }catch(e){}
  if(!id){
    id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : (Date.now().toString(36)+Math.random().toString(16).slice(2));
    try{ localStorage.setItem('fakkir_sid', id); }catch(e){}
  }
  return id;
}

// log one visit per tab-load to the private `visits` table (admin-only readable).
// Fire-and-forget; never blocks the UI. The real IP is added server-side.
async function logVisit(){
  if(!SUPABASE) return;
  try{ if(sessionStorage.getItem('fakkir_visit_logged')) return; }catch(e){}
  try{
    await SUPABASE.from('visits').insert({
      session_id: sessionId(),
      user_id: USER ? USER.id : null,
      user_name: USER ? userName() : null,
      path: location.pathname.slice(0,200),
      referrer: document.referrer ? document.referrer.slice(0,300) : '',
      user_agent: (navigator.userAgent||'').slice(0,400),
      language: (navigator.language||'').slice(0,40),
      screen: ((window.screen&&screen.width)||0)+'x'+((window.screen&&screen.height)||0),
      tz: (Intl.DateTimeFormat().resolvedOptions().timeZone||'').slice(0,60)
    });
    try{ sessionStorage.setItem('fakkir_visit_logged','1'); }catch(e){}
  }catch(e){ /* analytics is best-effort */ }
}

// Slow work (Supabase client + auth + leaderboard + a fresh data sync) runs here,
// AFTER first paint, so it can never block the UI or make buttons feel laggy.
async function initBackground(){
  try{
    await initSupabase();                       // loads supabase-js from CDN (slow) — off the critical path
    if(SUPABASE){
      await refreshSession();
      try{ SUPABASE.auth.onAuthStateChange((_e, session)=>{ USER = (session && session.user) || null; updateAuthUI(); }); }
      catch(e){ /* listener unavailable — login simply won't persist live */ }
    } else { updateAuthUI(); }
    renderLeaderboard();
    logVisit();                                 // record this visit for the admin analytics
  }catch(e){ console.warn('live services init failed', e); }
  refreshGameData();                            // silently freshen questions from the live source
}

// Pull the freshest question set from Supabase/API and swap it in — but only when
// it's safe (no active match / open question / blitz), so play is never disrupted.
async function refreshGameData(){
  if(CONFIG.preferSupabase === false) return;   // local is the chosen source: nothing to refresh
  let fresh = null, src = '';
  if(SUPABASE){ try{ fresh = await loadFromSupabase(); src = 'supabase'; }catch(e){} }
  if(!fresh){ try{ fresh = await loadFromApi(); src = 'api'; }catch(e){} }
  if(!fresh) return;                             // bundled local data is already showing — keep it
  // sanity: never replace the full bundled set with an empty/half-seeded source
  if(!Array.isArray(fresh.questions) || fresh.questions.length < 100 || !Array.isArray(fresh.categories) || !fresh.categories.length) return;
  localizeFlags(fresh);
  if(hasActiveMatch() || state.current || (typeof blitz !== 'undefined' && blitz.active)) return; // don't yank data mid-play
  const prev = DATA;
  DATA = fresh;
  try{ await mergeLocalOnlyCategories(src); }catch(e){ DATA = prev; return; }
  DATA_SOURCE = src;
  populateVersions();
  if(state.screen === 'category') renderCategories();
  else if(state.screen === 'board' && !state.current) buildBoard();
}

try{
  loadLocalState();
  bind();                 // wire every button FIRST so the UI responds instantly
  renderHeader();
  // instant content from the bundled file (cached by the service worker) — no network wait
  try{ DATA = await loadLocal(); localizeFlags(DATA); DATA_SOURCE = 'local'; setStatus('', 'ok'); }
  catch(e){ await loadData(); }   // bundled file unavailable -> fall back to the full source chain
  populateVersions();
  updateAuthUI();         // show the logged-out chip immediately; background sync updates it
  updateResumeUI();
  restoreScreen();        // return to the last screen right away
  initBackground();       // Supabase, auth, leaderboard, data refresh — all off the critical path
  if(recoveredCorruptState) setTimeout(()=>toast('تعذّرت استعادة الحفظ السابق (بيانات تالفة) — بدأنا من جديد بأمان.'), 400);
}catch(e){
  console.error(e);
  document.body.innerHTML = `<main class="fatal"><h1>تعذر تشغيل اللعبة</h1><p>${safe(e.message)}</p></main>`;
}
