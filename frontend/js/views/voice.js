// Voice Mentor — speak a question in your own language, hear Q-Bot answer it aloud.
// Powered by Sarvam (speech-to-text, text-to-speech, translation for 11 Indian languages).
// If Sarvam isn't configured, it falls back to the browser's built-in Web Speech API, so it
// always works. The answer itself still comes from the grounded AI tutor (api.ask).
import { api } from '../api.js';
import { store } from '../store.js';
import { esc, icon, hydrateIcons, toast, markdown } from '../ui.js';

const FALLBACK_LANGS = [
  { code: 'en-IN', name: 'English' }, { code: 'hi-IN', name: 'हिन्दी (Hindi)' },
  { code: 'bn-IN', name: 'বাংলা (Bengali)' }, { code: 'ta-IN', name: 'தமிழ் (Tamil)' },
  { code: 'te-IN', name: 'తెలుగు (Telugu)' }, { code: 'mr-IN', name: 'मराठी (Marathi)' },
];
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

function blobToDataURL(blob) {
  return new Promise((res) => { const r = new FileReader(); r.onloadend = () => res(r.result); r.readAsDataURL(blob); });
}

export async function render(root) {
  let status = { sarvam: false, provider: 'browser', languages: FALLBACK_LANGS };
  try { status = await api.voiceStatus(); } catch { /* use fallback */ }
  const langs = status.languages?.length ? status.languages : FALLBACK_LANGS;
  let lang = sessionStorage.getItem('q3d-voicelang') || 'en-IN';
  if (!langs.some((l) => l.code === lang)) lang = langs[0].code;
  const sarvam = !!status.sarvam;

  root.innerHTML = `
    <div class="row-between" style="margin-bottom:14px;flex-wrap:wrap;gap:10px">
      <div><span class="hand" style="font-size:1.3rem;color:var(--pink)">ask out loud. listen back.</span>
        <h2 style="margin:0">${icon('mic')} Voice Mentor</h2>
        <p class="muted" style="margin:4px 0 0">Speak a question in your language — Q-Bot answers and reads it back to you.</p></div>
      <span class="chip ${sarvam ? 'green' : 'gray'}" title="voice provider">${icon('volume')} ${sarvam ? 'Sarvam' : 'Browser voice'}</span>
    </div>

    <div class="grid" style="grid-template-columns:1fr 1fr;gap:18px;align-items:start">
      <div class="card">
        <div class="card-head"><h3 style="margin:0">${icon('globe')} Your question</h3>
          <select class="input" data-lang style="max-width:200px">
            ${langs.map((l) => `<option value="${l.code}" ${l.code === lang ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}
          </select></div>
        <div class="stack" style="gap:12px;margin-top:10px">
          <div class="row" style="gap:10px;align-items:center">
            <button class="btn btn-primary" data-mic style="min-width:150px">${icon('mic')} Hold to speak</button>
            <span class="faint small" data-rechint>${sarvam ? 'Records and transcribes with Sarvam.' : (SR ? 'Uses your browser microphone.' : 'Mic not available — type below.')}</span>
          </div>
          <textarea class="input" data-q rows="3" placeholder="…or type your question here">${''}</textarea>
          <div class="row" style="gap:10px">
            <button class="btn btn-primary btn-sm" data-ask>${icon('bot')} Ask Q-Bot</button>
            <button class="btn btn-ghost btn-sm" data-clear>${icon('undo')} Clear</button>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3 style="margin:0">${icon('bot')} Q-Bot</h3>
          <button class="btn btn-ghost btn-sm" data-replay disabled>${icon('volume')} Replay</button></div>
        <div data-transcript class="faint small" style="margin:6px 0"></div>
        <div data-answer class="stack" style="gap:8px;margin-top:6px"><p class="faint">Your answer will appear here — and play aloud.</p></div>
      </div>
    </div>
    <p class="faint tiny" style="margin-top:12px">${icon('info')} Tip: set <code>SARVAM_API_KEY</code> in your environment for high-quality Indian-language speech. Without it, the Voice Mentor uses your browser's built-in voices.</p>`;
  hydrateIcons(root);

  const qBox = root.querySelector('[data-q]');
  const transcriptBox = root.querySelector('[data-transcript]');
  const answerBox = root.querySelector('[data-answer]');
  const replayBtn = root.querySelector('[data-replay]');
  const micBtn = root.querySelector('[data-mic]');
  let lastAnswer = '';

  root.querySelector('[data-lang]').addEventListener('change', (e) => {
    lang = e.target.value; sessionStorage.setItem('q3d-voicelang', lang);
  });
  root.querySelector('[data-clear]').addEventListener('click', () => {
    qBox.value = ''; transcriptBox.textContent = ''; answerBox.innerHTML = '<p class="faint">Your answer will appear here — and play aloud.</p>';
    replayBtn.disabled = true; lastAnswer = '';
  });

  // ---- speak the answer (Sarvam TTS, else browser speechSynthesis)
  async function speak(text) {
    if (sarvam) {
      try {
        const r = await api.tts(text.slice(0, 1400), lang);
        const audio = new Audio(`data:${r.mime || 'audio/wav'};base64,${r.audio}`);
        await audio.play(); return;
      } catch { /* fall through to browser */ }
    }
    if (window.speechSynthesis) {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = lang.replace('-IN', lang === 'en-IN' ? '-IN' : '-IN');
      window.speechSynthesis.cancel(); window.speechSynthesis.speak(u);
    }
  }
  replayBtn.addEventListener('click', () => lastAnswer && speak(lastAnswer));

  // ---- ask the grounded tutor, show + speak the answer
  async function ask(question) {
    question = (question || '').trim();
    if (!question) { toast('Ask something first', 'error'); return; }
    answerBox.innerHTML = `<p class="faint">${icon('bot')} Thinking…</p>`; hydrateIcons(answerBox);
    try {
      const res = await api.ask({ question, user_id: store.user?.id, course: store.currentCourse || null });
      lastAnswer = res.answer || 'Sorry, I could not answer that.';
      answerBox.innerHTML = markdown(lastAnswer)
        + `<div class="row" style="gap:6px;margin-top:6px"><span class="chip gray">${esc(res.provider || 'offline')}</span></div>`;
      replayBtn.disabled = false;
      speak(lastAnswer.replace(/[#*`_>]/g, ''));
    } catch (e) { answerBox.innerHTML = `<p class="faint">${esc(e.message)}</p>`; }
  }
  root.querySelector('[data-ask]').addEventListener('click', () => ask(qBox.value));

  // ---- microphone: Sarvam STT via MediaRecorder, else browser SpeechRecognition
  let recorder = null; let chunks = []; let recognizing = false;

  async function startSarvamRecording() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = []; recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      micBtn.innerHTML = `${icon('mic')} Hold to speak`; hydrateIcons(micBtn);
      if (!chunks.length) return;
      const dataUrl = await blobToDataURL(new Blob(chunks, { type: chunks[0].type || 'audio/webm' }));
      transcriptBox.textContent = 'Transcribing…';
      try {
        const r = await api.stt(dataUrl, lang);
        qBox.value = r.text || ''; transcriptBox.textContent = r.text ? `🗣️ “${r.text}”` : 'Could not hear that — try again.';
        if (r.text) ask(r.text);
      } catch (e) { transcriptBox.textContent = ''; toast(e.status === 503 ? 'Sarvam not configured — type your question' : e.message, 'error'); }
    };
    recorder.start(); micBtn.innerHTML = `${icon('mic')} Recording… release`; hydrateIcons(micBtn);
  }

  function startBrowserRecognition() {
    if (!SR) { toast('Microphone not supported here — please type', 'error'); return; }
    const rec = new SR(); rec.lang = lang; rec.interimResults = false; recognizing = true;
    micBtn.innerHTML = `${icon('mic')} Listening…`; hydrateIcons(micBtn);
    rec.onresult = (e) => { const txt = e.results[0][0].transcript; qBox.value = txt; transcriptBox.textContent = `🗣️ “${txt}”`; ask(txt); };
    rec.onerror = () => toast('Did not catch that', 'error');
    rec.onend = () => { recognizing = false; micBtn.innerHTML = `${icon('mic')} Hold to speak`; hydrateIcons(micBtn); };
    rec.start();
  }

  if (sarvam && navigator.mediaDevices?.getUserMedia) {
    const begin = (e) => { e.preventDefault(); if (!recorder || recorder.state === 'inactive') startSarvamRecording().catch(() => toast('Microphone blocked', 'error')); };
    const end = (e) => { e.preventDefault(); if (recorder && recorder.state === 'recording') recorder.stop(); };
    micBtn.addEventListener('mousedown', begin); micBtn.addEventListener('touchstart', begin);
    window.addEventListener('mouseup', end); micBtn.addEventListener('touchend', end);
  } else {
    micBtn.addEventListener('click', () => { if (!recognizing) startBrowserRecognition(); });
  }
}
