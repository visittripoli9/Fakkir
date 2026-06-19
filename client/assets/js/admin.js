/* FAKKIR admin panel — owner-only. Talks to Supabase via the PostgREST REST API directly
   (raw fetch) using the service_role/secret key, which bypasses RLS for full read/write.
   The key is stored only in this browser (localStorage), never in the repo. */
const CFG = window.FAKKIR_CONFIG || {};
const SB_URL = CFG.supabaseUrl;
let API_KEY = null;      // apikey header (service_role OR the public anon key)
let AUTH_TOKEN = null;   // Authorization bearer (service_role OR an admin's session JWT)
let SB = null;           // supabase-js client, used only for admin-account login

// pinned + integrity-checked supabase-js (matches the main app)
const SUPABASE_JS_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.108.2';
const SUPABASE_JS_SRI = 'sha384-JWEyvHh+lRf0sN/WWY+QTQwX+CyWqmNg4tkc8GQzAMEtR2wGNrCJlvnu1lHD1kDm';
function loadScript(src, integrity) {
  return new Promise((resolve, reject) => {
    if ([...document.scripts].some((s) => s.src === src)) return resolve();
    const s = document.createElement('script'); s.src = src; s.onload = resolve; s.onerror = reject;
    if (integrity) { s.integrity = integrity; s.crossOrigin = 'anonymous'; s.referrerPolicy = 'no-referrer'; }
    document.head.appendChild(s);
  });
}
async function ensureSB() {
  if (SB) return SB;
  await loadScript(SUPABASE_JS_URL, SUPABASE_JS_SRI);
  SB = window.supabase.createClient(SB_URL, CFG.supabaseAnonKey);
  // keep the bearer fresh when supabase auto-refreshes the session token
  SB.auth.onAuthStateChange((_e, session) => { if (session && API_KEY === CFG.supabaseAnonKey) AUTH_TOKEN = session.access_token; });
  return SB;
}
let allCats = [];
let maxVersion = 15;
let editingId = null;   // null => add (questions)
let editingSlug = null; // null => add (categories)
let uploadedImage = null;

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const letter = (n) => String.fromCharCode(64 + Number(n));
function toast(m) { const t = $('#toast'); if (!t) return; t.textContent = m; t.classList.add('show'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 2800); }
function showScreen(id) { $$('.screen').forEach((s) => s.classList.remove('active')); const el = $('#' + id); if (el) el.classList.add('active'); }

// --- REST layer ---
async function rest(method, pathAndQuery, body, extraHeaders) {
  const headers = Object.assign(
    { apikey: API_KEY, Authorization: 'Bearer ' + AUTH_TOKEN, 'Content-Type': 'application/json' },
    extraHeaders || {}
  );
  let res, txt = '';
  try {
    res = await fetch(SB_URL + '/rest/v1/' + pathAndQuery, { method, headers, body: body != null ? JSON.stringify(body) : undefined });
    txt = await res.text();
  } catch (e) { return { ok: false, status: 0, data: { message: 'network: ' + e.message }, contentRange: null }; }
  let data = null; try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = { message: txt }; }
  return { ok: res.ok, status: res.status, data, contentRange: res.headers.get('content-range') };
}
const errMsg = (r) => (r.data && r.data.message) || ('HTTP ' + r.status);

// --- auth ---
async function validateKey(key) {
  if (!key || !SB_URL) return { err: 'no-key' };
  API_KEY = key; AUTH_TOKEN = key;
  const sel = await rest('GET', 'categories?select=slug&limit=1');
  if (!sel.ok) return { err: 'invalid', detail: errMsg(sel) };
  // probe write access on a FK-free table (flags); RLS blocks read-only keys
  const pk = '__rlsprobe_' + Date.now();
  const ins = await rest('POST', 'flags', { key: pk, image: 'probe' });
  if (!ins.ok) {
    if (ins.status === 401 || ins.status === 403 || (ins.data && /row-level security/i.test(ins.data.message || ''))) return { err: 'readonly' };
    return { err: 'other', detail: errMsg(ins) };
  }
  await rest('DELETE', 'flags?key=eq.' + pk);
  return { ok: true };
}
function loginError(err, detail) {
  if (err === 'readonly') return 'هذا المفتاح للقراءة فقط (publishable/anon). استخدم مفتاح service_role (secret).';
  if (err === 'invalid') return 'مفتاح غير صالح: ' + (detail || '');
  if (err === 'no-key') return 'أدخل المفتاح.';
  return 'تعذّر التحقق: ' + (detail || err);
}
async function doLogin(key, remember) {
  $('#adminError').textContent = 'جارٍ التحقق…';
  const res = await validateKey(key);
  if (!res.ok) { API_KEY = AUTH_TOKEN = null; $('#adminError').textContent = loginError(res.err, res.detail); return; }
  if (remember) localStorage.setItem('fakkir_admin_key', key); else sessionStorage.setItem('fakkir_admin_key', key);
  $('#adminError').textContent = '';
  await enterPanel();
}

// admin-account login: sign in with email+password, then confirm admin via RPC.
// Uses the public anon key + the account's session token; the DB RLS policies
// (server/sql/admin-role.sql) grant the powers — no service_role needed.
async function adminSignIn(email, password) {
  const err = $('#adminError'); err.textContent = 'جارٍ الدخول…';
  if (!email || !password) { err.textContent = 'أدخل البريد وكلمة المرور.'; return; }
  try {
    await ensureSB();
    const { data, error } = await SB.auth.signInWithPassword({ email, password });
    if (error) { err.textContent = 'فشل الدخول: ' + error.message; return; }
    const { data: ok, error: e2 } = await SB.rpc('fakkir_is_admin');
    if (e2) { err.textContent = 'تعذّر التحقق من الصلاحية (شغّل admin-role.sql): ' + e2.message; return; }
    if (!ok) { await SB.auth.signOut(); err.textContent = 'هذا الحساب ليس مشرفاً.'; return; }
    API_KEY = CFG.supabaseAnonKey;
    AUTH_TOKEN = data.session.access_token;
    err.textContent = '';
    await enterPanel();
  } catch (e3) { err.textContent = 'خطأ: ' + (e3 && e3.message || e3); }
}

async function logout() {
  localStorage.removeItem('fakkir_admin_key'); sessionStorage.removeItem('fakkir_admin_key');
  try { if (SB) await SB.auth.signOut(); } catch (e) {}
  API_KEY = AUTH_TOKEN = null;
  const k = $('#adminKey'); if (k) k.value = '';
  const p = $('#adminPass'); if (p) p.value = '';
  showScreen('adminGate');
}

async function enterPanel() {
  showScreen('adminPanel');
  await loadMeta();
  await Promise.all([loadStats(), loadVisits(), loadQuestions(), loadCategories(), loadMatches()]);
}

async function count(table) {
  const r = await rest('GET', table + '?select=id&limit=1', null, { Prefer: 'count=exact', Range: '0-0' });
  const cr = r.contentRange || '*/0'; const n = parseInt(cr.split('/')[1], 10); return isNaN(n) ? 0 : n;
}
async function loadStats() {
  const [cats, qs, flags, matches] = await Promise.all([count('categories'), count('questions'), count('flags'), count('matches')]);
  $('#adminStats').innerHTML = [['الفئات', cats], ['الأسئلة', qs], ['الأعلام', flags], ['المباريات', matches]]
    .map(([k, v]) => `<div class="astat"><b>${v}</b><span>${k}</span></div>`).join('');
}

async function loadMeta() {
  const c = await rest('GET', 'categories?select=slug,name&order=sort_order.asc'); allCats = c.data || [];
  const mx = await rest('GET', 'questions?select=version&order=version.desc&limit=1');
  maxVersion = mx.data && mx.data[0] ? mx.data[0].version : 15;
  const verOpts = Array.from({ length: maxVersion }, (_, i) => `<option value="${i + 1}">النسخة ${letter(i + 1)}</option>`).join('');
  $('#fVersion').innerHTML = '<option value="all">كل النسخ</option>' + verOpts;
  const bv = $('#bVersion'); if (bv) bv.innerHTML = '<option value="all">كل النسخ</option>' + verOpts;
  $('#fCategory').innerHTML = '<option value="all">كل الفئات</option>' + allCats.map((c) => `<option value="${esc(c.slug)}">${esc(c.name)}</option>`).join('');
  $('#eCategory').innerHTML = allCats.map((c) => `<option value="${esc(c.slug)}">${esc(c.name)}</option>`).join('');
}
function catName(slug) { const c = allCats.find((x) => x.slug === slug); return c ? c.name : slug; }

async function loadQuestions() {
  const v = $('#fVersion').value, cat = $('#fCategory').value, s = $('#fSearch').value.trim();
  let pq = 'questions?select=id,category,version,ord,value,type,q,a,note,flag&order=version.asc,category.asc,ord.asc&limit=700';
  if (v !== 'all') pq += '&version=eq.' + v;
  if (cat !== 'all') pq += '&category=eq.' + encodeURIComponent(cat);
  if (s) { const t = encodeURIComponent(s); pq += `&or=(q.ilike.*${t}*,a.ilike.*${t}*,note.ilike.*${t}*)`; }
  const r = await rest('GET', pq);
  if (!r.ok) { toast('خطأ: ' + errMsg(r)); return; }
  renderQuestions(r.data || []);
}
function renderQuestions(rows) {
  $('#qCount').textContent = `${rows.length} سؤال`;
  const head = '<thead><tr><th>النسخة</th><th>الفئة</th><th>قيمة</th><th>النوع</th><th>السؤال</th><th>الإجابة</th><th>ملاحظة/قصة</th><th></th></tr></thead>';
  const body = rows.map((r) => `<tr data-id="${r.id}">
    <td>${letter(r.version)}</td><td>${esc(catName(r.category))}</td><td>${r.value}</td>
    <td>${esc(r.type)}${r.flag ? ' (' + esc(r.flag) + ')' : ''}</td>
    <td class="cell-q">${esc(r.q)}</td><td>${esc(r.a)}</td><td class="cell-note">${esc(r.note)}</td>
    <td class="row-actions"><button class="mini" data-act="edit">تعديل</button><button class="mini danger" data-act="del">حذف</button></td>
  </tr>`).join('');
  $('#qTable').innerHTML = head + '<tbody>' + body + '</tbody>';
}

function openModal(row) {
  editingId = row ? row.id : null;
  $('#emTitle').textContent = row ? 'تعديل السؤال' : 'سؤال جديد';
  $('#eCategory').value = row ? row.category : (allCats[0] && allCats[0].slug) || '';
  $('#eVersion').value = row ? row.version : 1;
  $('#eOrd').value = row ? row.ord : 0;
  $('#eValue').value = row ? row.value : 200;
  $('#eType').value = row ? row.type : 'normal';
  $('#eFlag').value = row ? (row.flag || '') : '';
  $('#eQ').value = row ? (row.q || '') : '';
  $('#eA').value = row ? (row.a || '') : '';
  $('#eNote').value = row ? (row.note || '') : '';
  $('#emError').textContent = '';
  $('#editModal').classList.remove('hidden');
}
function closeModal() { $('#editModal').classList.add('hidden'); editingId = null; }
async function saveModal() {
  const payload = {
    category: $('#eCategory').value, version: Number($('#eVersion').value) || 1,
    ord: Number($('#eOrd').value) || 0, value: Number($('#eValue').value) || 0,
    type: $('#eType').value.trim() || 'normal', flag: $('#eFlag').value.trim() || null,
    q: $('#eQ').value.trim() || null, a: $('#eA').value.trim() || '', note: $('#eNote').value.trim() || null
  };
  $('#emError').textContent = 'جارٍ الحفظ…';
  const r = editingId ? await rest('PATCH', 'questions?id=eq.' + editingId, payload) : await rest('POST', 'questions', payload);
  if (!r.ok) { $('#emError').textContent = 'فشل الحفظ: ' + errMsg(r); return; }
  closeModal(); toast('تم الحفظ'); await Promise.all([loadStats(), loadQuestions()]);
}
async function onQTableClick(e) {
  const btn = e.target.closest('button[data-act]'); if (!btn) return;
  const id = btn.closest('tr').dataset.id;
  if (btn.dataset.act === 'del') {
    if (!confirm('حذف هذا السؤال نهائياً؟')) return;
    const r = await rest('DELETE', 'questions?id=eq.' + id);
    if (!r.ok) { toast('فشل الحذف: ' + errMsg(r)); return; }
    btn.closest('tr').remove(); toast('تم الحذف'); loadStats();
    return;
  }
  const r = await rest('GET', 'questions?select=id,category,version,ord,value,type,q,a,note,flag&id=eq.' + id);
  const row = r.data && r.data[0]; if (!row) { toast('تعذّر الجلب'); return; }
  openModal(row);
}

// --- categories ---
function fileToDataURL(file, max) {
  return new Promise((resolve, reject) => {
    const img = new Image(); const u = URL.createObjectURL(file);
    img.onload = () => {
      let w = img.naturalWidth, h = img.naturalHeight;
      const s = Math.min(1, max / Math.max(w, h));
      w = Math.max(1, Math.round(w * s)); h = Math.max(1, Math.round(h * s));
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(u); resolve(c.toDataURL('image/png'));
    };
    img.onerror = () => { URL.revokeObjectURL(u); reject(new Error('image load failed')); };
    img.src = u;
  });
}
async function onCatFile(e) {
  const f = e.target.files && e.target.files[0]; if (!f) return;
  try { uploadedImage = await fileToDataURL(f, 360); const p = $('#cPreview'); p.src = uploadedImage; p.style.display = 'block'; toast('تم تحميل الصورة'); }
  catch (err) { toast('تعذّر قراءة الصورة'); }
}
async function loadCategories() {
  const r = await rest('GET', 'categories?select=slug,name,color,image,sort_order&order=sort_order.asc');
  if (!r.ok) { $('#cTable').innerHTML = '<tbody><tr><td>تعذّر التحميل</td></tr></tbody>'; return; }
  const head = '<thead><tr><th>الترتيب</th><th>المعرّف</th><th>الاسم</th><th>اللون</th><th>الصورة</th><th></th></tr></thead>';
  const body = (r.data || []).map((c) => `<tr data-slug="${esc(c.slug)}">
    <td>${c.sort_order}</td><td>${esc(c.slug)}</td><td>${esc(c.name)}</td><td>${esc(c.color)}</td>
    <td class="cell-note">${esc((c.image || '').slice(0, 40))}</td>
    <td class="row-actions"><button class="mini" data-cact="edit">تعديل</button><button class="mini danger" data-cact="del">حذف</button></td>
  </tr>`).join('');
  $('#cTable').innerHTML = head + '<tbody>' + body + '</tbody>';
}
function openCatModal(c) {
  editingSlug = c ? c.slug : null; uploadedImage = null;
  $('#cmTitle').textContent = c ? 'تعديل الفئة' : 'فئة جديدة';
  $('#cSlug').value = c ? c.slug : ''; $('#cSlug').disabled = !!c;
  $('#cName').value = c ? c.name : ''; $('#cColor').value = c ? c.color : 'blue';
  $('#cImage').value = c ? (c.image || '') : ''; $('#cSort').value = c ? c.sort_order : 0;
  $('#cFile').value = '';
  const p = $('#cPreview'); if (c && c.image) { p.src = c.image; p.style.display = 'block'; } else { p.style.display = 'none'; p.removeAttribute('src'); }
  $('#cmError').textContent = ''; $('#catModal').classList.remove('hidden');
}
function closeCatModal() { $('#catModal').classList.add('hidden'); editingSlug = null; }
async function saveCat() {
  const slug = $('#cSlug').value.trim(); const name = $('#cName').value.trim();
  if (!slug) { $('#cmError').textContent = 'المعرّف (slug) مطلوب'; return; }
  if (!name) { $('#cmError').textContent = 'الاسم مطلوب'; return; }
  const fields = {
    name, color: $('#cColor').value.trim() || 'blue',
    image: uploadedImage || $('#cImage').value.trim() || ('assets/img/categories/' + slug + '.png'),
    sort_order: Number($('#cSort').value) || 0
  };
  $('#cmError').textContent = 'جارٍ الحفظ…';
  const r = editingSlug ? await rest('PATCH', 'categories?slug=eq.' + encodeURIComponent(editingSlug), fields)
                        : await rest('POST', 'categories', Object.assign({ slug }, fields));
  if (!r.ok) { $('#cmError').textContent = 'فشل الحفظ: ' + errMsg(r); return; }
  closeCatModal(); toast('تم الحفظ'); await Promise.all([loadStats(), loadCategories(), loadMeta()]);
}
async function onCTableClick(e) {
  const btn = e.target.closest('button[data-cact]'); if (!btn) return;
  const slug = btn.closest('tr').dataset.slug;
  if (btn.dataset.cact === 'del') {
    if (!confirm('حذف الفئة "' + slug + '" سيحذف أيضاً كل أسئلتها نهائياً. متابعة؟')) return;
    const r = await rest('DELETE', 'categories?slug=eq.' + encodeURIComponent(slug));
    if (!r.ok) { toast('فشل الحذف: ' + errMsg(r)); return; }
    toast('تم الحذف'); await Promise.all([loadStats(), loadCategories(), loadMeta(), loadQuestions()]);
    return;
  }
  const r = await rest('GET', 'categories?select=slug,name,color,image,sort_order&slug=eq.' + encodeURIComponent(slug));
  const row = r.data && r.data[0]; if (!row) { toast('تعذّر الجلب'); return; }
  openCatModal(row);
}

async function loadMatches() {
  const r = await rest('GET', 'matches?select=id,blue_name,red_name,blue_score,red_score,winner,created_at&order=created_at.desc&limit=100');
  if (!r.ok) { $('#mTable').innerHTML = '<tbody><tr><td>تعذّر تحميل النتائج</td></tr></tbody>'; return; }
  const head = '<thead><tr><th>التاريخ</th><th>الأزرق</th><th>الأحمر</th><th>النتيجة</th><th>الفائز</th><th></th></tr></thead>';
  const body = (r.data || []).map((m) => `<tr data-id="${m.id}">
    <td>${esc((m.created_at || '').slice(0, 16).replace('T', ' '))}</td>
    <td>${esc(m.blue_name)}</td><td>${esc(m.red_name)}</td><td>${m.blue_score} - ${m.red_score}</td><td>${esc(m.winner)}</td>
    <td class="row-actions"><button class="mini danger" data-mact="del">حذف</button></td>
  </tr>`).join('');
  $('#mTable').innerHTML = head + '<tbody>' + (body || '<tr><td>لا نتائج بعد</td></tr>') + '</tbody>';
}
async function onMTableClick(e) {
  const btn = e.target.closest('button[data-mact="del"]'); if (!btn) return;
  const id = btn.closest('tr').dataset.id;
  if (!confirm('حذف هذه المباراة نهائياً؟')) return;
  const r = await rest('DELETE', 'matches?id=eq.' + id);
  if (!r.ok) { toast('فشل الحذف: ' + errMsg(r)); return; }
  btn.closest('tr').remove(); toast('تم الحذف'); loadStats();
}

// --- visitor analytics ("who opened the site") ---
function parseUA(ua) {
  ua = ua || '';
  let browser = 'غير معروف';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/OPR\//.test(ua) || /Opera/.test(ua)) browser = 'Opera';
  else if (/SamsungBrowser/.test(ua)) browser = 'Samsung';
  else if (/Chrome\//.test(ua)) browser = 'Chrome';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Safari\//.test(ua)) browser = 'Safari';
  let os = 'غير معروف';
  if (/Windows/.test(ua)) os = 'Windows';
  else if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS';
  else if (/Mac OS X/.test(ua)) os = 'macOS';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/Linux/.test(ua)) os = 'Linux';
  const device = /Mobile|iPhone|Android.*Mobile/.test(ua) ? 'هاتف' : (/iPad|Tablet/.test(ua) ? 'لوحي' : 'حاسوب');
  return { browser, os, device };
}
function topCounts(rows, fn, n) {
  const m = new Map();
  rows.forEach((r) => { const k = fn(r) || '—'; m.set(k, (m.get(k) || 0) + 1); });
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}
function hostOf(u) { try { return u ? new URL(u).hostname : 'مباشر'; } catch (e) { return u || 'مباشر'; } }

async function loadVisits() {
  const days = Number($('#vRange').value);
  let q = 'visits?select=session_id,user_id,user_name,path,referrer,user_agent,language,screen,tz,ip,created_at&order=created_at.desc&limit=1000';
  if (days > 0) q += '&created_at=gte.' + new Date(Date.now() - days * 86400000).toISOString();
  const r = await rest('GET', q);
  if (!r.ok) { $('#vTable').innerHTML = '<tbody><tr><td>تعذّر التحميل (شغّل admin-analytics.sql)</td></tr></tbody>'; $('#vStats').innerHTML = ''; return; }
  const rows = r.data || [];
  const dayMs = Date.now() - 86400000;
  const uniq = new Set(rows.map((x) => x.session_id)).size;
  const loggedIn = rows.filter((x) => x.user_id).length;
  const today = rows.filter((x) => new Date(x.created_at).getTime() >= dayMs).length;
  $('#vStats').innerHTML = [
    ['زيارات', rows.length], ['زوّار مميّزون', uniq], ['مسجّلون', loggedIn], ['آخر ٢٤ساعة', today]
  ].map(([k, v]) => `<div class="astat"><b>${v}</b><span>${esc(k)}</span></div>`).join('');
  const block = (title, pairs) => `<div class="v-card"><h4>${esc(title)}</h4>` +
    (pairs.length ? pairs.map(([k, v]) => `<div class="v-row"><span>${esc(k)}</span><b>${v}</b></div>`).join('') : '<div class="v-row"><span>—</span></div>') + '</div>';
  $('#vBreak').innerHTML =
    block('المتصفحات', topCounts(rows, (x) => parseUA(x.user_agent).browser, 5)) +
    block('الأنظمة', topCounts(rows, (x) => parseUA(x.user_agent).os, 5)) +
    block('الأجهزة', topCounts(rows, (x) => parseUA(x.user_agent).device, 5)) +
    block('اللغات', topCounts(rows, (x) => (x.language || '').split('-')[0], 5)) +
    block('المصادر', topCounts(rows, (x) => hostOf(x.referrer), 5));
  const head = '<thead><tr><th>الوقت</th><th>الزائر</th><th>IP</th><th>الجهاز</th><th>اللغة</th><th>المصدر</th><th>الصفحة</th></tr></thead>';
  const body = rows.slice(0, 200).map((x) => {
    const ua = parseUA(x.user_agent);
    return `<tr>
      <td>${esc((x.created_at || '').slice(0, 16).replace('T', ' '))}</td>
      <td>${x.user_name ? esc(x.user_name) : '<span style="color:var(--muted)">زائر</span>'}</td>
      <td>${esc(x.ip || '—')}</td>
      <td>${esc(ua.browser + ' · ' + ua.os + ' · ' + ua.device)}</td>
      <td>${esc(x.language || '—')}</td>
      <td>${esc(hostOf(x.referrer))}</td>
      <td class="cell-note">${esc(x.path || '—')}</td>
    </tr>`;
  }).join('');
  $('#vTable').innerHTML = head + '<tbody>' + (body || '<tr><td>لا زيارات بعد</td></tr>') + '</tbody>';
}

// --- Blitz scores management (view + remove cheaters) ---
async function loadBlitz() {
  const v = $('#bVersion') ? $('#bVersion').value : 'all';
  let q = 'blitz_scores?select=id,player_name,score,correct,answered,max_streak,version,created_at&order=score.desc&limit=300';
  if (v && v !== 'all') q += '&version=eq.' + v;
  const r = await rest('GET', q);
  if (!r.ok) { $('#bTable').innerHTML = '<tbody><tr><td>تعذّر التحميل (شغّل blitz.sql)</td></tr></tbody>'; return; }
  const rows = r.data || [];
  $('#bCount').textContent = `${rows.length} نتيجة`;
  const head = '<thead><tr><th>#</th><th>اللاعب</th><th>النقاط</th><th>صحيحة/مجاب</th><th>أطول سلسلة</th><th>النسخة</th><th>التاريخ</th><th></th></tr></thead>';
  const body = rows.map((m, i) => `<tr data-id="${m.id}">
    <td>${i + 1}</td><td>${esc(m.player_name)}</td><td>${m.score}</td>
    <td>${m.correct}/${m.answered}</td><td>${m.max_streak}</td><td>${letter(m.version)}</td>
    <td>${esc((m.created_at || '').slice(0, 16).replace('T', ' '))}</td>
    <td class="row-actions"><button class="mini danger" data-bact="del">حذف</button></td>
  </tr>`).join('');
  $('#bTable').innerHTML = head + '<tbody>' + (body || '<tr><td>لا نتائج بعد</td></tr>') + '</tbody>';
}
async function onBTableClick(e) {
  const btn = e.target.closest('button[data-bact="del"]'); if (!btn) return;
  const id = btn.closest('tr').dataset.id;
  if (!confirm('حذف هذه النتيجة من لوحة المتصدرين؟')) return;
  const r = await rest('DELETE', 'blitz_scores?id=eq.' + id);
  if (!r.ok) { toast('فشل الحذف: ' + errMsg(r)); return; }
  btn.closest('tr').remove(); toast('تم الحذف');
}

function bindTabs() {
  $$('.admin-tab').forEach((t) => t.onclick = () => {
    $$('.admin-tab').forEach((x) => x.classList.toggle('active', x === t));
    const tab = t.dataset.tab;
    $('#tabVisitors').classList.toggle('hidden', tab !== 'visitors');
    $('#tabQuestions').classList.toggle('hidden', tab !== 'questions');
    $('#tabCategories').classList.toggle('hidden', tab !== 'categories');
    $('#tabBlitz').classList.toggle('hidden', tab !== 'blitz');
    $('#tabMatches').classList.toggle('hidden', tab !== 'matches');
    if (tab === 'visitors') loadVisits();
    if (tab === 'blitz') loadBlitz();
  });
}

function init() {
  // admin-account login (email + password)
  const signinBtn = $('#adminSignin');
  if (signinBtn) signinBtn.onclick = () => adminSignIn(($('#adminEmail').value || '').trim(), $('#adminPass').value || '');
  const passEl = $('#adminPass');
  if (passEl) passEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') signinBtn.click(); });
  // service_role key login (advanced/fallback)
  const keyBtn = $('#adminLogin');
  if (keyBtn) keyBtn.onclick = () => doLogin($('#adminKey').value.trim(), $('#adminRemember').checked);
  $('#adminKey').addEventListener('keydown', (e) => { if (e.key === 'Enter') keyBtn.click(); });
  $('#adminLogout').onclick = logout;
  $('#fApply').onclick = loadQuestions;
  $('#fSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadQuestions(); });
  $('#addNew').onclick = () => openModal(null);
  $('#eSave').onclick = saveModal;
  $('#eCancel').onclick = closeModal;
  $('#editModal').addEventListener('click', (e) => { if (e.target.id === 'editModal') closeModal(); });
  $('#qTable').addEventListener('click', onQTableClick);
  $('#addCat').onclick = () => openCatModal(null);
  $('#cFile').addEventListener('change', onCatFile);
  $('#cSave').onclick = saveCat;
  $('#cCancel').onclick = closeCatModal;
  $('#catModal').addEventListener('click', (e) => { if (e.target.id === 'catModal') closeCatModal(); });
  $('#cTable').addEventListener('click', onCTableClick);
  // visitors + blitz + matches management
  const vR = $('#vRefresh'); if (vR) vR.onclick = loadVisits;
  const vRange = $('#vRange'); if (vRange) vRange.onchange = loadVisits;
  const bR = $('#bRefresh'); if (bR) bR.onclick = loadBlitz;
  const bV = $('#bVersion'); if (bV) bV.onchange = loadBlitz;
  const bT = $('#bTable'); if (bT) bT.addEventListener('click', onBTableClick);
  const mT = $('#mTable'); if (mT) mT.addEventListener('click', onMTableClick);
  bindTabs();
  restoreSession();
}

// auto-enter if an admin is already signed in (their Supabase session), else
// fall back to a remembered service_role key.
async function restoreSession() {
  try {
    await ensureSB();
    const { data } = await SB.auth.getSession();
    if (data && data.session) {
      const { data: ok } = await SB.rpc('fakkir_is_admin');
      if (ok) { API_KEY = CFG.supabaseAnonKey; AUTH_TOKEN = data.session.access_token; enterPanel(); return; }
    }
  } catch (e) { /* supabase unavailable — fall through to key login */ }
  const saved = localStorage.getItem('fakkir_admin_key') || sessionStorage.getItem('fakkir_admin_key');
  if (saved) { API_KEY = AUTH_TOKEN = saved; validateKey(saved).then((res) => { if (res.ok) enterPanel(); else { API_KEY = AUTH_TOKEN = null; } }); }
}
init();
