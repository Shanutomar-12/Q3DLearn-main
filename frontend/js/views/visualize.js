// Topic Visualizer — an instructor uploads a PDF of a topic, and Q-3D Learn turns it into
// a visual lesson (summary, key concepts, quiz, formulas) and matches it to a live lab.
import { api } from '../api.js';
import { store } from '../store.js';
import { esc, icon, hydrateIcons, toast, markdown } from '../ui.js';
import { t, langPicker } from '../i18n.js';

function renderFormula(elem, tex) {
  if (window.katex) { try { window.katex.render(tex, elem, { throwOnError: false, displayMode: true }); return; } catch { /* fall through */ } }
  elem.innerHTML = `<code>${esc(tex)}</code>`;
}

export async function render(root, { query }) {
  const id = query?.get('id');
  const isInstr = store.user?.role === 'instructor';

  if (id) return detail(root, id);

  function shell() {
    root.innerHTML = `
      <div class="row-between" style="margin-bottom:14px">
        <div><span class="hand" style="font-size:1.3rem;color:var(--pink)">upload. visualize.</span>
          <h2 style="margin:0">${icon('eye')} Topic Visualizer</h2>
          <p class="muted" style="margin:4px 0 0">An instructor uploads a PDF of a topic — we turn it into a visual lesson and match it to a live lab.</p></div>
        <div class="row" data-lang></div>
      </div>
      ${isInstr ? `<div class="card" style="margin-bottom:16px"><div class="card-head"><h3 style="margin:0">${icon('upload')} Upload a topic PDF</h3></div>
        <form data-up class="stack" style="gap:10px">
          <input class="input" name="title" placeholder="Topic title (optional — e.g. Merge Sort)">
          <label class="drop" style="display:flex;gap:10px;align-items:center;border:1.5px dashed var(--line);border-radius:12px;padding:14px;cursor:pointer">
            ${icon('file')}<span data-fname class="muted">Choose a PDF file…</span>
            <input type="file" name="file" accept="application/pdf,.pdf" required hidden></label>
          <button class="btn btn-primary btn-sm" data-go>${icon('eye')} Visualize it</button>
          <span class="faint tiny">Uses your AI provider if a key is set, otherwise an offline keyword engine. Works with text PDFs (not scanned images).</span>
        </form></div>`
      : `<div class="callout insight" style="margin-bottom:16px"><i data-icon="info"></i><div>Topic lessons are created by instructors. Browse the ones below — each opens a visual lesson with a matched lab.</div></div>`}
      <h3 style="margin:6px 0 10px">Visualized topics</h3>
      <div data-list><div class="card empty"><i data-icon="eye"></i><div>Loading…</div></div></div>`;
    root.querySelector('[data-lang]').appendChild(langPicker(() => { shell(); load(); wire(); }));
    hydrateIcons(root);
  }

  function wire() {
    const form = root.querySelector('[data-up]');
    if (!form) return;
    const fileInput = form.file;
    form.querySelector('.drop').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => { form.querySelector('[data-fname]').textContent = fileInput.files[0]?.name || 'Choose a PDF file…'; });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!fileInput.files[0]) { toast('Pick a PDF first', 'error'); return; }
      const btn = form.querySelector('[data-go]'); btn.disabled = true; btn.innerHTML = 'Visualizing…';
      try {
        const fd = new FormData();
        fd.append('file', fileInput.files[0]);
        fd.append('title', form.title.value || '');
        fd.append('instructor_id', store.user.id);
        const topic = await api.uploadTopic(fd);
        if (topic.warning) toast(topic.warning, 'error');
        else toast('Topic visualized!', 'success');
        location.hash = `#/visualize?id=${topic.id}`;
      } catch (err) { toast(err.message, 'error'); btn.disabled = false; btn.innerHTML = 'Visualize it'; }
    });
  }

  async function load() {
    const box = root.querySelector('[data-list]');
    try {
      const topics = await api.visualizeTopics();
      box.innerHTML = topics.length ? `<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px">${topics.map((tp) => `
        <a class="card" href="#/visualize?id=${tp.id}" style="text-decoration:none;color:inherit;display:block">
          <div class="card-head"><h3 style="margin:0;font-size:1.05rem">${esc(tp.title)}</h3>${tp.lab_title ? `<span class="chip green">${icon('eye')} lab</span>` : ''}</div>
          <p class="faint small" style="margin:4px 0">${tp.lab_title ? 'Visualized with: ' + esc(tp.lab_title) : 'Text lesson'} · by ${esc(tp.instructor_name || 'Instructor')}</p>
        </a>`).join('')}</div>`
        : `<div class="card empty"><i data-icon="eye"></i><div>No topics yet. ${isInstr ? 'Upload a PDF above to create the first one.' : 'Ask your instructor to upload a topic.'}</div></div>`;
      hydrateIcons(box);
    } catch (e) { box.innerHTML = `<div class="card empty"><i data-icon="alert"></i><div>${esc(e.message)}</div></div>`; hydrateIcons(box); }
  }

  shell(); wire(); await load();
}

// ---------------------------------------------------------------- topic detail
async function detail(root, id) {
  root.innerHTML = `<div class="card empty"><i data-icon="eye"></i><div>Loading…</div></div>`;
  hydrateIcons(root);
  let tp;
  try { tp = await api.visualizeTopic(id); }
  catch (e) { root.innerHTML = `<div class="card empty"><i data-icon="alert"></i><div>${esc(e.message)}</div></div>`; hydrateIcons(root); return; }

  root.innerHTML = `
    <a class="btn btn-ghost btn-sm" href="#/visualize">${icon('undo')} All topics</a>
    <div class="row-between" style="margin:12px 0">
      <div><span class="hand" style="font-size:1.2rem;color:var(--pink)">visualized topic</span>
        <h2 style="margin:0">${esc(tp.title)}</h2></div>
      ${tp.lab ? `<button class="btn btn-primary" data-openlab>${icon('eye')} Open the ${esc(tp.lab_title)} lab</button>` : ''}
    </div>
    <div class="grid" style="grid-template-columns:1.3fr 1fr;gap:18px;align-items:start">
      <div class="stack" style="gap:14px">
        <div class="card"><div class="card-head"><h3 style="margin:0">${icon('book')} Summary</h3><span class="chip gray">${esc(tp.provider)}</span></div>
          <p>${markdown(tp.summary || 'No summary available.')}</p>
          ${(tp.key_concepts || []).length ? `<div class="row" style="gap:6px;flex-wrap:wrap;margin-top:6px">${tp.key_concepts.map((k) => `<span class="chip">${esc(k)}</span>`).join('')}</div>` : ''}</div>
        ${(tp.formulas || []).length ? `<div class="card"><div class="card-head"><h3 style="margin:0">${icon('code')} Key formulas</h3></div><div data-formulas class="stack" style="gap:8px"></div></div>` : ''}
        ${tp.project && tp.project.title ? `<div class="card" style="border:1.5px solid color-mix(in srgb,var(--pink) 35%,transparent)">
          <div class="card-head"><h3 style="margin:0">${icon('cap')} ${esc(tp.project.title)}</h3><span class="chip pink">task</span></div>
          <p class="small">${esc(tp.project.brief || '')}</p>
          ${(tp.project.steps || []).length ? `<ol class="small" style="margin:6px 0 0;padding-left:18px">${tp.project.steps.map((s) => `<li style="margin:4px 0">${esc(s)}</li>`).join('')}</ol>` : ''}
          ${tp.project.deliverable ? `<p class="faint small" style="margin-top:8px">${icon('checkCircle')} <b>Deliverable:</b> ${esc(tp.project.deliverable)}</p>` : ''}</div>` : ''}
      </div>
      <div class="stack" style="gap:14px">
        ${tp.lab ? `<div class="card" style="border:1.5px solid color-mix(in srgb,var(--green) 40%,transparent)">
          <div class="card-head"><h3 style="margin:0">${icon('eye')} Visualization</h3></div>
          <p class="small">This topic is best shown by the <b>${esc(tp.lab_title)}</b> lab. Open it to see it move — real, interactive, computed live.</p>
          <button class="btn btn-primary btn-sm" data-openlab2>${icon('arrowRight')} Open interactive lab</button></div>`
        : `<div class="card"><p class="faint small">${icon('info')} No single lab matched this topic, so it's shown as a text lesson.</p></div>`}
        ${(tp.quiz || []).length ? `<div class="card"><div class="card-head"><h3 style="margin:0">${icon('checkCircle')} Practice questions</h3><span class="chip gray">${(tp.quiz || []).length}</span></div><div data-quiz class="stack" style="gap:14px"></div></div>` : ''}
        <div class="card" data-insights hidden><div class="card-head"><h3 style="margin:0">${icon('graph')} Explore next</h3><span class="chip gray" data-insrc>graph</span></div>
          <div data-insights-body class="stack" style="gap:10px"><p class="faint small">Finding related labs…</p></div></div>
      </div>
    </div>`;
  hydrateIcons(root);

  // Graph-powered: other labs to explore + related concepts (from the knowledge graph).
  if (tp.lab) {
    api.topicInsights(id).then((ins) => {
      const card = root.querySelector('[data-insights]');
      const body = root.querySelector('[data-insights-body]');
      const labs = ins.related_labs || []; const concepts = ins.related_concepts || [];
      if (!labs.length && !concepts.length) { card.remove(); return; }
      root.querySelector('[data-insrc]').textContent = ins.source === 'neo4j' ? '● Neo4j' : 'graph';
      body.innerHTML = (labs.length ? `<div><p class="faint small" style="margin:0 0 6px">Related labs</p>${labs.map((l) =>
          `<button class="btn btn-ghost btn-sm" data-open="${esc(l.open || '')}" style="margin:0 6px 6px 0">${icon('eye')} ${esc(l.label)}</button>`).join('')}</div>` : '')
        + (concepts.length ? `<div><p class="faint small" style="margin:6px 0 4px">Related concepts</p><div class="row" style="gap:6px;flex-wrap:wrap">${concepts.map((c) => `<span class="chip">${esc(c)}</span>`).join('')}</div></div>` : '');
      card.hidden = false; hydrateIcons(card);
      card.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => { if (b.dataset.open) location.hash = b.dataset.open; }));
    }).catch(() => root.querySelector('[data-insights]')?.remove());
  }

  const openLab = () => { if (tp.course && tp.lab) location.hash = `#/c/${tp.course}/lab/${tp.lab}`; };
  root.querySelector('[data-openlab]')?.addEventListener('click', openLab);
  root.querySelector('[data-openlab2]')?.addEventListener('click', openLab);

  const fbox = root.querySelector('[data-formulas]');
  if (fbox) (tp.formulas || []).forEach((f) => { const d = document.createElement('div'); fbox.appendChild(d); renderFormula(d, f); });

  const qbox = root.querySelector('[data-quiz]');
  if (qbox) (tp.quiz || []).forEach((q, i) => {
    const block = document.createElement('div');
    block.innerHTML = `<div style="font-weight:600;margin-bottom:6px">${i + 1}. ${esc(q.q || q.prompt || '')}</div>
      ${(q.options || []).map((o, j) => `<label class="opt"><input type="radio" name="vq${i}" value="${j}"> <span>${esc(o)}</span></label>`).join('')}
      <div class="faint small" data-exp style="display:none;margin-top:4px"></div>`;
    qbox.appendChild(block);
    block.querySelectorAll(`[name="vq${i}"]`).forEach((inp) => inp.addEventListener('change', () => {
      const chosen = +inp.value; const ans = q.answer ?? 0;
      block.querySelectorAll('.opt').forEach((lab, j) => {
        lab.style.cssText = j === ans ? 'background:color-mix(in srgb,var(--green) 18%,transparent);border-radius:8px'
          : (j === chosen ? 'background:color-mix(in srgb,var(--red) 15%,transparent);border-radius:8px' : '');
        lab.querySelector('input').disabled = true;
      });
      const exp = block.querySelector('[data-exp]');
      if (q.explain) { exp.textContent = '💡 ' + q.explain; exp.style.display = 'block'; }
    }));
  });
}
