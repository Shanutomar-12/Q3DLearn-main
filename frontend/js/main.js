// App shell: routing, course-aware sidebar, theme, profile, AI drawer, backend status.
import { api } from './api.js';
import { store } from './store.js';
import { $, $$, esc, hydrateIcons, initials, toast, icon } from './ui.js';
import { Chat } from './components/chat.js';
import { initSky, onSkyChange, info as skyInfo } from './sky.js';
import { applyPrefs, openSettings, openAmbience } from './study/settings.js';
import { initFocus, openFocus, startFocus } from './study/focus.js';
import { openPalette } from './study/palette.js';

const QUANTUM_LABS = {
  bloch: () => import('./views/lab.js'),
  builder: () => import('./views/builder.js'),
  algorithms: () => import('./views/algorithms.js'),
};

let cleanup = null;
let drawerChat = null;
let navToken = 0;
let progressCache = null;

export function navigate(path) {
  if (location.hash === `#${path}`) route();
  else location.hash = path;
}

export function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [pathPart, query = ''] = raw.split('?');
  const parts = pathPart.split('/').filter(Boolean).map(decodeURIComponent);
  return { parts, query: new URLSearchParams(query) };
}

/** Resolve the current hash into {key, title, course, load, params}. */
function resolve() {
  const { parts, query } = parseHash();
  const legacy = { learn: 'learn', lab: 'lab/bloch', builder: 'lab/builder', algorithms: 'lab/algorithms', challenges: 'challenges' };
  if (legacy[parts[0]]) {
    const rest = parts.slice(1).join('/');
    location.replace(`#/c/quantum/${legacy[parts[0]]}${rest ? `/${rest}` : ''}${query.toString() ? `?${query}` : ''}`);
    return null;
  }
  if (parts[0] === 'c' && parts[1]) {
    const course = parts[1];
    const section = parts[2] || 'overview';
    const base = { course, query };
    if (section === 'overview') return { ...base, key: 'overview', title: 'Overview', load: () => import('./views/course.js'), params: [] };
    if (section === 'learn') return { ...base, key: 'learn', title: 'Lessons', load: () => import('./views/learn.js'), params: parts.slice(3) };
    if (section === 'challenges') return { ...base, key: 'challenges', title: 'Challenges', load: () => import('./views/challenges.js'), params: parts.slice(3) };
    if (section === 'lab' && parts[3]) {
      const lab = parts[3];
      if (course === 'quantum' && QUANTUM_LABS[lab]) {
        const titles = { bloch: '3D Bloch Lab', builder: 'Circuit Builder', algorithms: 'Algorithm Library' };
        return { ...base, key: `lab:${lab}`, title: titles[lab], load: QUANTUM_LABS[lab], params: parts.slice(4) };
      }
      return { ...base, key: `lab:${lab}`, title: 'Lab', load: () => import('./views/labview.js'), params: [lab] };
    }
  }
  const simple = {
    tutor: ['AI Tutor', () => import('./views/tutor.js')],
    progress: ['My Progress', () => import('./views/progress.js')],
    instructor: ['Instructor Dashboard', () => import('./views/instructor.js')],
    about: ['About the Project', () => import('./views/about.js')],
    review: ['Review cards', () => import('./views/review.js')],
    glossary: ['Glossary', () => import('./views/glossary.js')],
    brainmap: ['Brain Map', () => import('./views/brainmap.js')],
    knowledgegraph: ['Knowledge Graph', () => import('./views/knowledgegraph.js')],
    voice: ['Voice Mentor', () => import('./views/voice.js')],
    radar: ['Memory Radar', () => import('./views/radar.js')],
    notes: ['My notebook', () => import('./views/notes.js')],
    certificate: ['Certificate', () => import('./views/certificate.js')],
    leaderboard: ['Leaderboard', () => import('./views/leaderboard.js')],
    community: ['Community', () => import('./views/community.js')],
    practice: ['Practice', () => import('./views/practice.js')],
    projects: ['Mini-projects', () => import('./views/projects.js')],
    tests: ['Tests', () => import('./views/tests.js')],
    authoring: ['Create course', () => import('./views/authoring.js')],
    institution: ['Institution', () => import('./views/institution.js')],
    visualize: ['Topic Visualizer', () => import('./views/visualize.js')],
    login: ['Sign in', () => import('./views/auth.js')],
  };
  if (simple[parts[0]]) return { key: parts[0], title: simple[parts[0]][0], load: simple[parts[0]][1], params: parts.slice(1), query, course: null };
  return { key: 'home', title: 'Study desk', load: () => import('./views/home.js'), params: [], query, course: null };
}

function applyCourse(cid) {
  const meta = store.courseMeta(cid);
  document.documentElement.style.setProperty('--course', meta ? `var(--c-${cid})` : 'var(--primary)');
}

/* ------------------------------------------------- role-based access control */
// Instructors and institutes each see ONLY their own area; students see everything else.
const INSTRUCTOR_KEYS = new Set(['instructor', 'authoring', 'visualize', 'tests', 'knowledgegraph', 'tutor', 'about']);
const INSTITUTE_KEYS = new Set(['institution', 'knowledgegraph', 'about']);
const STUDENT_BLOCK = new Set(['instructor', 'authoring', 'visualize', 'institution']);

export function roleHome(role) {
  return role === 'instructor' ? '/instructor' : role === 'institute' ? '/institution' : '/';
}
function roleAllows(role, key) {
  if (role === 'instructor') return INSTRUCTOR_KEYS.has(key);
  if (role === 'institute') return INSTITUTE_KEYS.has(key);
  return !STUDENT_BLOCK.has(key); // student
}
export async function refreshAfterLogin() {
  renderUserChip();
  await refreshProgress().catch(() => {});
  // the caller navigates to the role's home next, which triggers a fresh route()
}

async function route() {
  const token = ++navToken;
  const r = resolve();
  if (!r) return;
  // Auth gate: must be signed in; each role is confined to its own pages.
  const onLogin = r.key === 'login';
  document.body.classList.toggle('auth-mode', onLogin);
  if (!store.user && !onLogin) { navigate('/login'); return; }
  if (store.user && !onLogin && !roleAllows(store.user.role, r.key)) { navigate(roleHome(store.user.role)); return; }
  if (r.course && !store.courseMeta(r.course)) { navigate('/'); return; }
  if (r.course) store.set('course', r.course);
  store.currentCourse = r.course || null;
  applyCourse(r.course);
  store.labContext = null;
  if (r.key !== 'challenges') store.context.challenge_id = null;
  if (r.key !== 'learn') store.context.lesson_id = null;
  renderNav(r);
  const meta = store.courseMeta(r.course);
  const labMeta = meta?.labs.find((l) => `lab:${l.id}` === r.key);
  const title = labMeta ? labMeta.title : r.title;
  $('#page-title').innerHTML = meta
    ? `<span class="crumb"><a href="#/c/${meta.id}">${esc(meta.title)}</a></span><span class="sep">›</span><span class="here">${esc(title)}</span>`
    : `<span class="here">${esc(r.title)}</span>`;
  document.title = `${title}${meta ? ` · ${meta.short}` : ''} · Q-3D Learn`;
  $('#sidebar').classList.remove('open');
  try { cleanup?.(); } catch (e) { console.error(e); }
  cleanup = null;
  const view = $('#view');
  view.innerHTML = '';
  view.style.animation = 'none';
  void view.offsetWidth;
  view.style.animation = '';
  try {
    const mod = await r.load();
    if (token !== navToken) return;
    const result = await mod.render(view, { params: r.params, query: r.query, course: r.course });
    if (token !== navToken) { result?.(); return; }
    cleanup = typeof result === 'function' ? result : null;
    hydrateIcons(view);
  } catch (e) {
    console.error(e);
    view.innerHTML = `<div class="card empty"><i data-icon="alert"></i><div>Something went wrong loading this page.<br><span class="faint small">${esc(e.message)}</span></div></div>`;
    hydrateIcons(view);
  }
  window.scrollTo({ top: 0 });
}

/* --------------------------------------------------------------- sidebar */
function renderNav(r = resolve()) {
  if (!r) return;
  const link = (href, ic, label, active, extra = '') => `<a href="${href}" class="${active ? 'active' : ''}" ${extra}><i data-icon="${ic}"></i><span>${esc(label)}</span></a>`;
  const u = store.user;
  // No sidebar on the sign-in page or before signing in.
  if (!u || r.key === 'login') { $('#nav').innerHTML = ''; return; }

  // Instructor: only the teaching tools.
  if (u.role === 'instructor') {
    let h = '<div class="nav-label">Teaching</div>';
    h += link('#/instructor', 'users', 'Instructor dashboard', r.key === 'instructor');
    h += link('#/authoring', 'cap', 'Create course', r.key === 'authoring');
    h += link('#/visualize', 'eye', 'Topic Visualizer', r.key === 'visualize');
    h += link('#/tests', 'checkCircle', 'Tests & questions', r.key === 'tests');
    h += link('#/knowledgegraph', 'graph', 'Knowledge Graph', r.key === 'knowledgegraph');
    h += '<div class="nav-label">Assistant</div>';
    h += link('#/tutor', 'bot', 'AI Tutor (Q-Bot)', r.key === 'tutor');
    h += '<div class="nav-label">Account</div>';
    h += link('#/about', 'info', 'About the Project', r.key === 'about');
    $('#nav').innerHTML = h; hydrateIcons($('#nav')); return;
  }

  // Institute: only the organisation dashboard.
  if (u.role === 'institute') {
    let h = '<div class="nav-label">Institute</div>';
    h += link('#/institution', 'school', 'Institution (SSO)', r.key === 'institution');
    h += link('#/knowledgegraph', 'graph', 'Knowledge Graph', r.key === 'knowledgegraph');
    h += '<div class="nav-label">Account</div>';
    h += link('#/about', 'info', 'About the Project', r.key === 'about');
    $('#nav').innerHTML = h; hydrateIcons($('#nav')); return;
  }

  // Student: courses + study tools + compete (no teaching/institute pages).
  const cur = r.course;
  let html = link('#/', 'home', 'Study desk', r.key === 'home');
  html += '<div class="nav-label">Courses</div>';
  for (const c of store.courses) {
    const pct = progressCache?.courses?.[c.id]?.progress_pct;
    html += `<a href="#/c/${c.id}" class="course-tab ${cur === c.id ? 'current' : ''}"><span class="dot" style="background:var(--c-${c.id})"><i data-icon="${c.icon}"></i></span><span>${esc(c.title)}</span>${pct ? `<span class="pct">${pct}%</span>` : ''}</a>`;
    if (cur === c.id) {
      html += `<div class="course-sub" style="--course:var(--c-${c.id})">
        ${link(`#/c/${c.id}`, 'notebook', 'Overview', r.key === 'overview')}
        ${link(`#/c/${c.id}/learn`, 'book', 'Lessons', r.key === 'learn')}
        ${c.labs.map((l) => link(`#/c/${c.id}/lab/${l.id}`, l.icon, l.title, r.key === `lab:${l.id}`)).join('')}
        ${link(`#/c/${c.id}/challenges`, 'trophy', 'Challenges', r.key === 'challenges')}
        ${link(`#/projects/${c.id}`, 'rocket', 'Mini-projects', false)}
      </div>`;
    }
  }
  html += '<div class="nav-label">Study tools</div>';
  html += link('#/review', 'cards', 'Review cards', r.key === 'review', '').replace('</span></a>', `</span>${store.dueCount ? `<span class="badge" title="cards due">${store.dueCount}</span>` : ''}</a>`);
  html += link('#/glossary', 'abc', 'Glossary', r.key === 'glossary');
  html += link('#/brainmap', 'mindmap', 'Brain Map', r.key === 'brainmap');
  html += link('#/knowledgegraph', 'graph', 'Knowledge Graph', r.key === 'knowledgegraph');
  html += link('#/radar', 'radar', 'Memory Radar', r.key === 'radar');
  html += link('#/notes', 'notebook', 'My notebook', r.key === 'notes');
  html += link('#/tutor', 'bot', 'AI Tutor (Q-Bot)', r.key === 'tutor');
  html += link('#/voice', 'mic', 'Voice Mentor', r.key === 'voice');
  html += link('#/progress', 'chart', 'My Progress', r.key === 'progress');
  html += '<div class="nav-label">Compete & connect</div>';
  html += link('#/leaderboard', 'trophy', 'Leaderboard', r.key === 'leaderboard');
  html += link('#/community', 'chat', 'Community', r.key === 'community');
  html += link('#/practice', 'code', 'Practice (LeetCode)', r.key === 'practice');
  html += link('#/tests', 'checkCircle', 'Tests', r.key === 'tests');
  html += '<div class="nav-label">More</div>';
  html += link('#/about', 'info', 'About the Project', r.key === 'about');
  $('#nav').innerHTML = html;
  hydrateIcons($('#nav'));
}

export async function refreshProgress() {
  if (!store.user) { progressCache = null; store.dueCount = 0; return null; }
  try { progressCache = await api.progress(store.user.id); } catch { progressCache = null; }
  refreshNavBadges();
  renderNav();
  return progressCache;
}

/** Due-card count for the sidebar badge. */
export async function refreshNavBadges(redraw = true) {
  if (!store.user) { store.dueCount = 0; return; }
  try { store.dueCount = (await api.reviewStats(store.user.id)).due; } catch { /* offline */ }
  if (redraw) renderNav();
}

/* --------------------------------------------------------------- living sky chip */
function renderSkyChip(i = skyInfo()) {
  const chip = $('#sky-chip');
  if (!chip) return;
  chip.innerHTML = `<span class="sky-ic">${i.icon}</span><span class="sky-txt">${i.live ? `${i.temp}°` : esc(i.phase)}</span>`;
  chip.title = `Living sky: ${i.phase}${i.live ? ` · ${i.temp}°C, ${i.words}${i.place ? ` in ${i.place.name}` : ''}` : ''} — click to change the mood`;
}

const PALETTE_ACTIONS = () => [
  { t: 'Start a 25-minute focus block', sub: 'Pomodoro timer', ic: 'clock', run: () => { startFocus(25); toast('Focus block started — you’ve got this! ⏳', 'success'); } },
  { t: 'Change the sky & ambient sound', sub: 'Living sky', ic: 'cloud', run: () => openAmbience($('#sky-chip')) },
  { t: 'Toggle light / dark mode', sub: 'Theme', ic: 'moon', run: () => { setTheme(store.theme === 'dark' ? 'light' : 'dark'); route(); } },
  { t: 'Study settings', sub: 'Text size, motion, contrast, install', ic: 'gear', run: () => openSettings() },
  { t: 'Ask Q-Bot', sub: 'AI tutor drawer', ic: 'bot', run: () => openDrawer() },
];

/* --------------------------------------------------------------- shared actions */
export function openDrawer(question) {
  const d = $('#drawer');
  if (!drawerChat) drawerChat = new Chat($('#drawer-chat'), { compact: true });
  d.classList.add('open');
  d.setAttribute('aria-hidden', 'false');
  d.removeAttribute('inert');
  $('#scrim').classList.add('show');
  if (question) drawerChat.ask(question);
  else setTimeout(() => d.querySelector('textarea')?.focus(), 250);
}

function closeDrawer() {
  $('#drawer').classList.remove('open');
  $('#drawer').setAttribute('aria-hidden', 'true');
  $('#drawer').setAttribute('inert', '');
  $('#scrim').classList.remove('show');
}

export function loadIntoBuilder(numQubits, operations, title) {
  store.set('circuit', { num_qubits: numQubits, operations });
  if (title) toast(`Loaded “${esc(title)}” into the Circuit Builder`, 'success', 2200);
  navigate('/c/quantum/lab/builder');
}

export function loadIntoLab(operations) {
  sessionStorage.setItem('q3d-lab-ops', JSON.stringify(operations));
  navigate('/c/quantum/lab/bloch');
}

/** Open any course lab with a preset configuration. */
export function openLab(course, lab, preset = {}) {
  sessionStorage.setItem('q3d-lab-preset', JSON.stringify({ course, lab, preset }));
  navigate(`/c/${course}/lab/${lab}`);
}

export function takeLabPreset(course, lab) {
  try {
    const p = JSON.parse(sessionStorage.getItem('q3d-lab-preset') || 'null');
    if (p && p.course === course && p.lab === lab) { sessionStorage.removeItem('q3d-lab-preset'); return p.preset || {}; }
  } catch { /* ignore */ }
  return {};
}

/* --------------------------------------------------------------- profile & theme */
function renderUserChip() {
  const u = store.user;
  const roleLabel = u ? (u.role === 'instructor' ? 'Instructor' : u.role === 'institute' ? 'Institute' : 'Learner') : '';
  $('#user-chip').innerHTML = u
    ? `<span class="avatar">${esc(initials(u.name))}</span><span class="uname">${esc(u.name)}<small>${roleLabel}${u.classroom_code ? ` · ${esc(u.classroom_code)}` : ''}</small></span>`
    : `<span class="avatar">?</span><span class="uname">Sign in<small>save your progress</small></span>`;
}

function setTheme(t) {
  store.set('theme', t);
  document.documentElement.dataset.theme = t;
  $('#theme-btn').innerHTML = icon(t === 'dark' ? 'sun' : 'moon');
  document.querySelector('meta[name="theme-color"]').content = t === 'dark' ? '#14161d' : '#f8f4ea';
}

export function openProfile(force = false) {
  const m = $('#modal');
  const u = store.user;
  m.hidden = false;
  m.innerHTML = `<form class="modal-card stack" data-form>
    <div><span class="hand" style="font-size:1.4rem;color:var(--pink)">${u ? 'hello again!' : 'welcome, new student!'}</span><h2>${u ? 'Your profile' : 'Open your study notebook'}</h2>
    <p class="muted small">${u ? 'Update your details or switch profile.' : 'Create a learner profile to save lessons, quiz scores, challenges and experiments across every course. No password needed.'}</p></div>
    <label class="field">Your name<input class="input" name="name" maxlength="80" required value="${esc(u?.name || '')}" placeholder="e.g. Ada"></label>
    <div class="role-pick" style="grid-template-columns:repeat(3,1fr)">
      <label><input type="radio" name="role" value="student" ${!u || u.role === 'student' ? 'checked' : ''}> <span><b>Student</b><br><small class="faint">Learn</small></span></label>
      <label><input type="radio" name="role" value="instructor" ${u?.role === 'instructor' ? 'checked' : ''}> <span><b>Instructor</b><br><small class="faint">Teach</small></span></label>
      <label><input type="radio" name="role" value="institute" ${u?.role === 'institute' ? 'checked' : ''}> <span><b>Institute</b><br><small class="faint">Manage</small></span></label>
    </div>
    <label class="field">Classroom code <span class="faint">(optional — try DEMO42 after loading the demo class)</span><input class="input mono" name="code" maxlength="12" value="${esc(u?.classroom_code || '')}" placeholder="ABC123"></label>
    <div class="row" style="justify-content:flex-end">
      ${u ? '<button type="button" class="btn btn-danger" data-signout>Sign out</button>' : ''}
      ${!force || u ? '<button type="button" class="btn btn-ghost" data-close>Not now</button>' : ''}
      <button class="btn btn-primary" type="submit">${u ? 'Save' : 'Start learning'}</button>
    </div></form>`;
  const form = m.querySelector('[data-form]');
  setTimeout(() => form.name.focus(), 50);
  const close = () => { m.hidden = true; m.innerHTML = ''; };
  m.querySelector('[data-close]')?.addEventListener('click', () => { sessionStorage.setItem('q3d-skip-profile', '1'); close(); });
  m.querySelector('[data-signout]')?.addEventListener('click', () => { store.set('user', null); progressCache = null; renderUserChip(); close(); toast('Signed out'); navigate('/login'); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = form.name.value.trim();
    const role = form.role.value;
    const code = form.code.value.trim().toUpperCase() || null;
    try {
      let user;
      if (u && u.name === name && u.role === role) {
        user = code && code !== u.classroom_code ? { ...u, ...(await api.joinClass(u.id, code)) } : { ...u, classroom_code: code || u.classroom_code };
      } else {
        user = await api.createUser({ name, role, classroom_code: code });
      }
      store.set('user', user);
      renderUserChip();
      close();
      toast(`Welcome, ${esc(user.name)}!`, 'success');
      await refreshProgress();
      route();
    } catch (err) { toast(err.message, 'error'); }
  });
}

/* --------------------------------------------------------------- boot */
async function checkBackend() {
  const pill = $('#status-pill');
  try {
    const sys = await api.system();
    store.system = sys;
    pill.className = 'status-pill ok';
    const q = sys.qiskit.available ? 'Qiskit Aer' : 'Q3D engine';
    const ai = sys.ai_provider === 'offline' ? 'offline tutor' : sys.ai_provider;
    $('#status-text').textContent = `${q} · ${ai}`;
    pill.title = `Backend v${sys.version} · DB ${sys.database} · Quantum: ${q} · AI: ${ai}`;
    $('#drawer-provider').textContent = sys.ai_provider === 'offline' ? 'offline study buddy (add an API key for LLM answers)' : `powered by ${sys.ai_provider}`;
  } catch {
    pill.className = 'status-pill err';
    $('#status-text').textContent = 'Backend offline';
  }
}

async function boot() {
  applyPrefs();
  hydrateIcons();
  setTheme(store.theme === 'dark' ? 'dark' : 'light');
  renderUserChip();
  $('#menu-btn').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
  $('#open-drawer').addEventListener('click', () => openDrawer());
  $('#close-drawer').addEventListener('click', closeDrawer);
  $('#scrim').addEventListener('click', closeDrawer);
  $('#user-chip').addEventListener('click', () => (store.user ? openProfile() : navigate('/login')));
  $('#theme-btn').addEventListener('click', () => { setTheme(store.theme === 'dark' ? 'light' : 'dark'); route(); });
  $('#settings-btn').addEventListener('click', () => openSettings());
  $('#search-btn').addEventListener('click', () => openPalette(PALETTE_ACTIONS()));
  $('#sky-chip').addEventListener('click', () => openAmbience($('#sky-chip')));
  $('#focus-btn').addEventListener('click', () => openFocus($('#focus-btn')));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawer();
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(PALETTE_ACTIONS()); return; }
    if (e.target.closest('input, textarea, select, [contenteditable]') || e.ctrlKey || e.metaKey || e.altKey || !$('#modal').hidden) return;
    if (e.key === '/') { e.preventDefault(); openPalette(PALETTE_ACTIONS()); }
    if ((e.key === 'r' || e.key === 'R') && !location.hash.startsWith('#/review')) navigate('/review');
  });
  initSky();
  renderSkyChip();
  onSkyChange(renderSkyChip);
  initFocus();
  const net = () => document.documentElement.classList.toggle('is-offline', !navigator.onLine);
  window.addEventListener('online', () => { net(); checkBackend(); toast('Back online', 'success'); });
  window.addEventListener('offline', () => { net(); toast('You are offline — lessons you opened before still work.', 'info', 5000); });
  net();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
    // Reload once when a new service worker takes control, so a redeploy reaches the user
    // without a manual hard-refresh (prevents stale cached code).
    let swReloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (swReloaded) return; swReloaded = true; location.reload();
    });
    navigator.serviceWorker.register('sw.js').then((reg) => { reg.update?.(); }).catch(() => { /* optional */ });
  }

  checkBackend();
  try {
    const [g, courses] = await Promise.all([api.gates(), api.courses()]);
    store.gates = Object.fromEntries(g.gates.map((x) => [x.name, x]));
    store.courses = courses;
  } catch {
    toast('Cannot reach the Q-3D Learn backend. Start it with <code>python run.py</code>.', 'error', 8000);
  }
  if (store.user) {
    try { store.set('user', { ...store.user, ...(await api.getUser(store.user.id)) }); } catch (e) { if (e.status === 404) store.set('user', null); }
    renderUserChip();
  }
  window.addEventListener('hashchange', route);
  refreshProgress();
  await route(); // the route guard sends signed-out visitors to the clean #/login page
}

boot();

export { icon, progressCache };
