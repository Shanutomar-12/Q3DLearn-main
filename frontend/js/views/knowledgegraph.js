// Knowledge Graph — the whole platform as one connected graph: courses → lessons → labs →
// concepts, with cross-course links. Served from Neo4j when it holds data, otherwise built
// in-memory on the backend. Rendered as a live force-directed graph on canvas.
import { api } from '../api.js';
import { store } from '../store.js';
import { esc, icon, hydrateIcons, toast } from '../ui.js';

const TYPE_STYLE = {
  course: { r: 9, label: 'Course' }, lab: { r: 6.5, label: 'Lab' },
  lesson: { r: 5, label: 'Lesson' }, concept: { r: 3.6, label: 'Concept' },
};
const CPROG = ['quantum', 'ml', 'ds', 'ai', 'dsa', 'cyber', 'chain', 'dl'];

export async function render(root) {
  const isInstr = store.user?.role === 'instructor';
  let course = sessionStorage.getItem('q3d-kg') || 'all';
  const courses = store.courses || [];

  root.innerHTML = `
    <div class="row-between" style="margin-bottom:10px;flex-wrap:wrap;gap:10px">
      <div><span class="hand" style="font-size:1.3rem;color:var(--violet)">one connected brain</span>
        <h2 style="margin:0">${icon('graph')} Knowledge Graph</h2>
        <p class="muted" style="margin:4px 0 0">Every course, lesson, lab and concept as one graph — powered by Neo4j. Drag nodes, tap a lab to open it.</p></div>
      <div class="row" style="gap:8px;align-items:center">
        <span class="chip gray" data-source>built-in</span>
        ${isInstr ? `<button class="btn btn-ghost btn-sm" data-sync>${icon('database')} Sync to Neo4j</button>` : ''}
      </div>
    </div>
    <div class="seg" data-pick style="max-width:760px;margin-bottom:12px;flex-wrap:wrap">
      <button data-c="all" class="${course === 'all' ? 'active' : ''}">🧠 All</button>
      ${courses.map((c) => `<button data-c="${c.id}" class="${course === c.id ? 'active' : ''}">${esc(c.short)}</button>`).join('')}
    </div>
    <div class="card" style="padding:0;overflow:hidden;position:relative">
      <canvas data-canvas style="display:block;width:100%;height:540px;cursor:grab"></canvas>
      <div class="row" style="position:absolute;left:12px;bottom:10px;gap:12px;flex-wrap:wrap;pointer-events:none;font-size:.72rem">
        ${Object.entries(TYPE_STYLE).map(([k, v]) => `<span style="display:inline-flex;align-items:center;gap:5px"><span style="width:10px;height:10px;border-radius:50%;background:var(--violet);opacity:${k === 'concept' ? 0.5 : 1}"></span>${v.label}</span>`).join('')}
      </div>
      <div class="faint tiny" data-stats style="position:absolute;right:12px;top:10px"></div>
      <button class="btn btn-ghost btn-sm" data-relayout style="position:absolute;right:12px;bottom:10px">${icon('reset')} Re-layout</button>
      <div data-panel style="position:absolute;top:10px;right:10px;width:260px;max-width:72%;background:var(--surface-solid,var(--surface));border:1px solid var(--line-strong);border-radius:12px;box-shadow:var(--shadow-lift);padding:12px;display:none;max-height:92%;overflow:auto"></div>
    </div>
    <div class="row" data-pathbar style="gap:8px;margin-top:10px;flex-wrap:wrap;align-items:center;display:none">
      <span class="chip" data-pfrom></span><span class="faint">→</span><span class="chip" data-pto></span>
      <button class="btn btn-primary btn-sm" data-findpath>${icon('arrowRight')} Find learning path</button>
      <button class="btn btn-ghost btn-sm" data-clearpath>${icon('reset')} Clear</button>
      <span class="faint small" data-pathout></span>
    </div>
    <p class="faint tiny" style="margin-top:10px">${icon('info')} Click any node to explore what it connects to, or set two nodes as <b>start</b> and <b>target</b> to find the shortest learning path between them. Add <code>NEO4J_URI</code> / <code>NEO4J_PASSWORD</code> to run these as real Neo4j queries.</p>`;
  hydrateIcons(root);

  const canvas = root.querySelector('[data-canvas]');
  const ctx = canvas.getContext('2d');
  const sourceChip = root.querySelector('[data-source]');
  const statsBox = root.querySelector('[data-stats]');
  let nodes = []; let edges = []; let raf = 0; let alpha = 1;
  let drag = null; let pan = { x: 0, y: 0 }; let W = 0; let H = 0;
  let selected = null; let pathFrom = null; let pathTo = null;
  let pathIds = new Set();   // node ids on the current highlighted path
  const panel = root.querySelector('[data-panel]');
  const pathbar = root.querySelector('[data-pathbar]');

  function size() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    W = rect.width; H = rect.height;
    canvas.width = W * dpr; canvas.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  async function load() {
    statsBox.textContent = 'loading…';
    selected = null; pathFrom = null; pathTo = null; pathIds = new Set();
    if (panel) panel.style.display = 'none';
    if (pathbar) pathbar.style.display = 'none';
    try {
      const g = await api.brainGraph(course);
      const byId = new Map();
      nodes = g.nodes.map((n) => {
        const node = { ...n, x: W / 2 + (Math.random() - 0.5) * 240, y: H / 2 + (Math.random() - 0.5) * 240, vx: 0, vy: 0 };
        byId.set(n.id, node); return node;
      });
      edges = g.edges.map((e) => ({ s: byId.get(e.source), t: byId.get(e.target), rel: e.rel })).filter((e) => e.s && e.t);
      sourceChip.textContent = g.source === 'neo4j' ? '● Neo4j' : 'built-in graph';
      sourceChip.className = `chip ${g.source === 'neo4j' ? 'green' : 'gray'}`;
      statsBox.textContent = `${g.counts.nodes} nodes · ${g.counts.edges} links`;
      alpha = 1; tick();
    } catch (e) { statsBox.textContent = ''; toast(e.message, 'error'); }
  }

  function step() {
    const k = 0.012; const repulse = 900; const center = 0.008;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      if (a === drag) continue;
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        let dx = a.x - b.x; let dy = a.y - b.y; let d2 = dx * dx + dy * dy || 1;
        if (d2 > 90000) continue; // ignore far pairs — keeps it fast
        const f = repulse / d2; const d = Math.sqrt(d2);
        dx /= d; dy /= d; a.vx += dx * f * alpha; a.vy += dy * f * alpha;
        if (b !== drag) { b.vx -= dx * f * alpha; b.vy -= dy * f * alpha; }
      }
      a.vx += (W / 2 - a.x) * center * alpha; a.vy += (H / 2 - a.y) * center * alpha;
    }
    for (const e of edges) {
      const dx = e.t.x - e.s.x; const dy = e.t.y - e.s.y; const d = Math.hypot(dx, dy) || 1;
      const rest = e.rel === 'HAS_LAB' ? 46 : e.rel === 'TEACHES' ? 40 : e.rel === 'RELATED_TO' ? 120 : 34;
      const f = (d - rest) * k * alpha; const ux = dx / d; const uy = dy / d;
      if (e.s !== drag) { e.s.vx += ux * f; e.s.vy += uy * f; }
      if (e.t !== drag) { e.t.vx -= ux * f; e.t.vy -= uy * f; }
    }
    for (const n of nodes) { if (n === drag) continue; n.x += n.vx; n.y += n.vy; n.vx *= 0.82; n.vy *= 0.82; }
    alpha *= 0.992; if (alpha < 0.02) alpha = 0.02;
  }

  const GOLD = '#f59e0b';
  function draw() {
    ctx.clearRect(0, 0, W, H);
    const hp = pathIds.size > 0;
    for (const e of edges) {
      const onPath = hp && pathIds.has(e.s.id) && pathIds.has(e.t.id);
      ctx.beginPath(); ctx.moveTo(e.s.x, e.s.y); ctx.lineTo(e.t.x, e.t.y);
      if (onPath) { ctx.strokeStyle = GOLD; ctx.lineWidth = 3; }
      else { ctx.strokeStyle = e.rel === 'RELATED_TO' ? 'rgba(139,92,246,0.22)' : 'rgba(148,148,168,0.18)'; ctx.lineWidth = e.rel === 'RELATED_TO' ? 1.4 : 1; }
      ctx.globalAlpha = hp && !onPath ? 0.4 : 1; ctx.stroke(); ctx.globalAlpha = 1;
    }
    const txt = getComputedStyle(document.body).getPropertyValue('--text') || '#111';
    for (const n of nodes) {
      const st = TYPE_STYLE[n.type] || TYPE_STYLE.concept;
      const onPath = pathIds.has(n.id); const isSel = n === selected;
      const dim = (hp && !onPath) ? 0.35 : (n.type === 'concept' ? 0.55 : 1);
      ctx.beginPath(); ctx.arc(n.x, n.y, st.r, 0, Math.PI * 2);
      ctx.fillStyle = n.color || '#8b5cf6'; ctx.globalAlpha = dim; ctx.fill(); ctx.globalAlpha = 1;
      if (isSel || onPath) {
        ctx.beginPath(); ctx.arc(n.x, n.y, st.r + 3.5, 0, Math.PI * 2);
        ctx.strokeStyle = onPath ? GOLD : txt; ctx.lineWidth = 2.5; ctx.stroke();
      }
      if (n.type === 'course' || isSel || onPath) {
        if (n.type === 'course') { ctx.beginPath(); ctx.arc(n.x, n.y, st.r + 2.5, 0, Math.PI * 2); ctx.strokeStyle = n.color || '#8b5cf6'; ctx.lineWidth = 1.5; ctx.stroke(); }
        ctx.fillStyle = txt; ctx.font = `600 ${isSel || onPath ? 12 : 11}px system-ui`; ctx.textAlign = 'center';
        ctx.fillText(n.label, n.x, n.y - st.r - 6);
      }
    }
  }

  function tick() { step(); draw(); cancelAnimationFrame(raf); if (alpha > 0.021) raf = requestAnimationFrame(tick); else draw(); }

  // interaction ------------------------------------------------------------
  function at(mx, my) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i]; const st = TYPE_STYLE[n.type] || TYPE_STYLE.concept;
      if ((mx - n.x) ** 2 + (my - n.y) ** 2 <= (st.r + 4) ** 2) return n;
    }
    return null;
  }
  function pos(e) { const r = canvas.getBoundingClientRect(); const p = e.touches ? e.touches[0] : e; return { x: p.clientX - r.left, y: p.clientY - r.top }; }

  canvas.addEventListener('mousedown', (e) => { const p = pos(e); drag = at(p.x, p.y); if (drag) canvas.style.cursor = 'grabbing'; });
  window.addEventListener('mousemove', (e) => {
    if (!drag) return; const p = pos(e); drag.x = p.x; drag.y = p.y; drag.vx = drag.vy = 0; alpha = Math.max(alpha, 0.3);
    if (!raf) tick();
  });
  window.addEventListener('mouseup', () => { if (drag) canvas.style.cursor = 'grab'; drag = null; });
  let clickStart = null;
  canvas.addEventListener('mousedown', (e) => { const p = pos(e); clickStart = p; });
  canvas.addEventListener('click', (e) => {
    const p = pos(e);
    if (clickStart && (Math.abs(p.x - clickStart.x) > 4 || Math.abs(p.y - clickStart.y) > 4)) return; // was a drag
    const n = at(p.x, p.y);
    if (n) selectNode(n); else closePanel();
  });

  function labelFor(n) { return `${(TYPE_STYLE[n.type] || {}).label || n.type}`; }
  function nodeById(id) { return nodes.find((x) => x.id === id); }

  async function selectNode(n) {
    selected = n; draw();
    panel.style.display = 'block';
    panel.innerHTML = `<div class="row-between" style="align-items:flex-start;gap:8px">
        <div><span class="chip gray" style="font-size:.68rem">${labelFor(n)}</span>
          <div style="font-weight:700;margin-top:4px">${esc(n.label)}</div></div>
        <button class="btn btn-ghost btn-sm" data-x style="padding:2px 7px">✕</button></div>
      ${n.open ? `<button class="btn btn-primary btn-sm" data-openlab style="margin-top:8px;width:100%">${icon('eye')} Open this lab</button>` : ''}
      <div class="row" style="gap:6px;margin-top:8px">
        <button class="btn btn-ghost btn-sm" data-setfrom style="flex:1">Start</button>
        <button class="btn btn-ghost btn-sm" data-setto style="flex:1">Target</button></div>
      <p class="faint small" style="margin:10px 0 4px">Connected to</p>
      <div data-rel class="stack" style="gap:4px"><p class="faint tiny">Loading…</p></div>`;
    hydrateIcons(panel);
    panel.querySelector('[data-x]').onclick = closePanel;
    panel.querySelector('[data-openlab]')?.addEventListener('click', () => { if (n.open) location.hash = n.open; });
    panel.querySelector('[data-setfrom]').onclick = () => { pathFrom = n; refreshPathbar(); };
    panel.querySelector('[data-setto]').onclick = () => { pathTo = n; refreshPathbar(); };
    try {
      const r = await api.brainRelated(n.id, 8);
      const box = panel.querySelector('[data-rel]');
      box.innerHTML = (r.related || []).length ? r.related.map((x) => `
        <button class="btn btn-ghost btn-sm" data-go="${esc(x.id)}" data-open="${esc(x.open || '')}" style="width:100%;justify-content:flex-start;gap:6px">
          ${icon(x.type === 'lab' ? 'eye' : x.type === 'concept' ? 'sparkle' : 'book')} <span>${esc(x.label)}</span></button>`).join('')
        : '<p class="faint tiny">No connections found.</p>';
      box.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => {
        if (b.dataset.open) { location.hash = b.dataset.open; return; }
        const t = nodeById(b.dataset.go); if (t) selectNode(t);
      }));
    } catch { panel.querySelector('[data-rel]').innerHTML = '<p class="faint tiny">Could not load connections.</p>'; }
  }
  function closePanel() { selected = null; panel.style.display = 'none'; draw(); }

  function refreshPathbar() {
    pathbar.style.display = (pathFrom || pathTo) ? 'flex' : 'none';
    root.querySelector('[data-pfrom]').textContent = pathFrom ? pathFrom.label : 'pick start';
    root.querySelector('[data-pto]').textContent = pathTo ? pathTo.label : 'pick target';
    root.querySelector('[data-pathout]').textContent = '';
  }
  root.querySelector('[data-findpath]').addEventListener('click', async () => {
    if (!pathFrom || !pathTo) { toast('Pick a start and a target node first', 'error'); return; }
    const out = root.querySelector('[data-pathout]'); out.textContent = 'Finding…';
    try {
      const r = await api.brainPath(pathFrom.id, pathTo.id);
      if (!r.found) { out.textContent = r.error || 'No path found'; pathIds = new Set(); draw(); return; }
      pathIds = new Set(r.path.map((s) => s.id)); alpha = Math.max(alpha, 0.12); tick();
      out.innerHTML = `${r.source === 'neo4j' ? '● Neo4j' : 'graph'} · ${r.hops} steps: ` + r.path.map((s) => esc(s.label)).join(' → ');
    } catch (e) { out.textContent = e.message; }
  });
  root.querySelector('[data-clearpath]').addEventListener('click', () => {
    pathFrom = pathTo = null; pathIds = new Set(); refreshPathbar(); draw();
  });

  root.querySelector('[data-pick]').addEventListener('click', (e) => {
    const b = e.target.closest('[data-c]'); if (!b) return;
    course = b.dataset.c; sessionStorage.setItem('q3d-kg', course);
    root.querySelectorAll('[data-c]').forEach((x) => x.classList.toggle('active', x === b));
    load();
  });
  root.querySelector('[data-relayout]').addEventListener('click', () => {
    for (const n of nodes) { n.x = W / 2 + (Math.random() - 0.5) * 240; n.y = H / 2 + (Math.random() - 0.5) * 240; n.vx = n.vy = 0; }
    alpha = 1; tick();
  });
  root.querySelector('[data-sync]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget; btn.disabled = true; btn.innerHTML = 'Syncing…';
    try { const r = await api.brainSync(store.user?.id); toast(`Synced ${r.nodes} nodes to Neo4j`, 'success'); load(); }
    catch (err) { toast(err.status === 503 ? 'Neo4j not connected — set NEO4J_URI to enable' : err.message, 'error'); }
    finally { btn.disabled = false; btn.innerHTML = `${icon('database')} Sync to Neo4j`; hydrateIcons(btn); }
  });

  size(); window.addEventListener('resize', () => { size(); draw(); });
  await load();
}
