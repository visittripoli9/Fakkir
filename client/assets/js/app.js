const CONFIG = window.FAKKIR_CONFIG || {};
let DATA = null;
let DATA_SOURCE = 'local';
let SUPABASE = null;
let timerInt = null;
let _audio = null;

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
  if(id === 'home') updateResumeUI();
  state.screen = id;          // remember where we are so a reload can restore it
  saveLocal();
  window.scrollTo({top:0, behavior:'smooth'});
}

async function loadScript(src){
  return new Promise((resolve,reject)=>{
    if([...document.scripts].some(s => s.src === src)) return resolve();
    const s=document.createElement('script');
    s.src=src; s.onload=resolve; s.onerror=reject;
    document.head.appendChild(s);
  });
}

async function initSupabase(){
  if(!CONFIG.supabaseUrl || !CONFIG.supabaseAnonKey) return null;
  try{
    await loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2');
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
    clues: Array.isArray(row.clues) ? row.clues : (row.clues ? JSON.parse(row.clues) : null),
    num: row.num == null ? null : Number(row.num),
    evidence: row.evidence || '',
    suspects: Array.isArray(row.suspects) ? row.suspects : (row.suspects ? JSON.parse(row.suspects) : null)
  };
}

// PostgREST caps a response at 1000 rows, so page through all questions.
async function loadAllQuestions(sb){
  const cols = 'category,version,ord,value,type,q,a,note,flag,clues,num,evidence,suspects';
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
      localizeFlags(DATA); // always serve flags from the app project folder, not a remote CDN
      DATA_SOURCE = source;
      setStatus('', 'ok'); // hide the technical data-source banner from players
      return;
    }catch(e){
      console.warn(`Data load failed from ${source}`, e);
    }
  }
  throw new Error('No data source available');
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

function renderHeader(){
  const theme = localStorage.getItem('theme') || CONFIG.defaultTheme || 'dark';
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
    el.innerHTML = `<img src="${safe(cat.image)}" alt="${safe(cat.name)}"><span class="num">${idx>=0?idx+1:''}</span><h3>${safe(cat.name)}</h3><small>${countQuestions(cat.slug)} أسئلة</small>`;
    el.onclick = () => toggleCategory(cat.slug);
    grid.appendChild(el);
  });
  $('#catCount').textContent = `اخترت ${state.selected.length} من 6`;
  $('#goBoard').disabled = state.selected.length !== 6;
}

function countQuestions(slug){ return DATA.questions.filter(q => q.category === slug && q.version === state.settings.version).length; }
function toggleCategory(slug){
  const i = state.selected.indexOf(slug);
  if(i>=0) state.selected.splice(i,1);
  else {
    if(state.selected.length>=6) return toast('اخترت 6 فئات بالفعل');
    state.selected.push(slug);
  }
  state.golden={}; // board composition changed — re-roll golden tiles next time
  saveLocal();
  renderCategories();
}

function startFlow(){
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
  $('#blueScore').textContent = state.teams.blue.score;
  $('#redScore').textContent = state.teams.red.score;
  $('#turnLabel').textContent = state.teams[state.turn].name;
  renderSkips();

  state.selected.forEach(slug=>{
    const c = cat(slug);
    const qs = qList(slug).slice(0,6);
    const tile = document.createElement('section');
    tile.className='board-tile';
    tile.innerHTML = `<div class="board-image"><img src="${safe(c.image)}" alt="${safe(c.name)}"></div><h3>${safe(c.name)}</h3><div class="points-grid">` + qs.map(q=>{
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

function renderVisual(q,c,target){
  const box = $(target);
  box.innerHTML='';
  const img = document.createElement('img');
  img.src = (q.type === 'flag' && q.flag && DATA.flags[q.flag]) ? DATA.flags[q.flag] : c.image;
  img.alt = c.name;
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
  beep(170,0.3,'square');
  if(cur.phase==='initial'){
    cur.phase = 'steal';
    cur.answerer = other(cur.answerer);
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
  $('#timer').textContent = n;
  saveLocal();
  timerInt = setInterval(()=>{
    n--;
    $('#timer').textContent = n;
    if(n<=0){ clearInterval(timerInt); state.timerEndsAt = null; handleTimeout(); }
  },1000);
}

function answerText(q){
  if(q.type==='crime') return `الجاني: ${q.a}`;
  if(q.type==='rescue') return `الحكم: ${q.a}`;
  if(q.type==='closest') return `الرقم الصحيح: ${q.num || q.a}`;
  return `الإجابة: ${q.a}`;
}
function showAnswer(){
  const q=state.current.q;
  const box=$('#answerBox');
  const scenario = q.category==='crime' || q.category==='rescue'; // note holds the case story, already shown
  box.textContent = answerText(q) + (!scenario && q.note?` — ${q.note}`:'') + (q.evidence?` — ${q.evidence}`:'');
  box.classList.remove('hidden');
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
  beep(880,0.16,'sine');
  if(cur.mode==='challenge') return finishChallenge(true);
  setAward(cur.answerer, 'correct');
  finishQuestion(cur.phase==='steal' ? 'سرقة ناجحة' : 'إجابة صحيحة', cur.answerer);
}

function wrongAnswer(reason){
  const cur = state.current; if(!cur) return;
  beep(170,0.3,'square');
  if(cur.mode==='challenge') return finishChallenge(false); // comeback round stays a bonus: no deduction
  setAward(cur.answerer, 'wrong'); // wrong answer = normal base deduction (golden never penalizes extra)
  const lead = reason ? (reason + ' — ') : '';
  if(cur.phase==='initial'){
    // deducted from the team on turn — now hand the question to the other team to steal
    refreshQScores();
    cur.phase = 'steal';
    cur.answerer = other(cur.answerer);
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
  renderVisual(cur.q,cur.c,'#resultVisual');
  renderGoldenReveal();
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
async function renderLeaderboard(){
  let localRows = [];
  try{ localRows = JSON.parse(localStorage.getItem('fakkir_leaderboard')||'[]'); }catch(e){ localRows = []; }
  if(!Array.isArray(localRows)) localRows = [];
  localRows = localRows.slice().reverse();
  if(SUPABASE){
    try{
      const { data, error } = await SUPABASE.from('matches').select('winner,blue_score,red_score,created_at').order('created_at', { ascending:false }).limit(20);
      if(!error && data){
        $('#leaderRows').innerHTML = data.length ? data.map((r,i)=>leaderRow(i, r.winner, r.blue_score, r.red_score)).join('') : '<p>لا توجد نتائج بعد.</p>';
        return;
      }
    }catch(e){ console.warn(e); }
  }
  $('#leaderRows').innerHTML = localRows.length ? localRows.map((r,i)=>leaderRow(i, r.winner, r.blue_score ?? r.blue, r.red_score ?? r.red)).join('') : '<p>لا توجد نتائج بعد.</p>';
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
  if(soundToggle){ updateSoundIcon(); soundToggle.onclick=()=>{ state.settings.sound=!state.settings.sound; saveLocal(); updateSoundIcon(); if(state.settings.sound) beep(700,0.12,'sine'); }; }
}

const verLetter = n => String.fromCharCode(64 + n); // 1 -> A ... 15 -> O

function beep(freq, dur, type){
  if(!state.settings.sound) return;
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
function updateSoundIcon(){
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
}

try{
  loadLocalState();
  await loadData();
  bind();
  populateVersions();
  renderHeader();
  renderLeaderboard();
  // after a reload, return the player to the screen they were on (not always home)
  updateResumeUI();
  restoreScreen();
  // safe recovery notice if a corrupt/outdated save was discarded on load
  if(recoveredCorruptState) setTimeout(()=>toast('تعذّرت استعادة الحفظ السابق (بيانات تالفة) — بدأنا من جديد بأمان.'), 400);
}catch(e){
  console.error(e);
  document.body.innerHTML = `<main class="fatal"><h1>تعذر تشغيل اللعبة</h1><p>${safe(e.message)}</p></main>`;
}
