// Real login / sign-up with email + password, three roles (Student, Instructor, Institute).
// Passwords are verified server-side (PBKDF2); this page validates, then calls /api/auth/*.
// Each role lands on — and only ever sees — its own area (gating lives in main.js).
import { api } from '../api.js';
import { store } from '../store.js';
import { esc, icon, hydrateIcons, toast } from '../ui.js';
import { navigate, roleHome, refreshAfterLogin } from '../main.js';

const ROLES = [
  { id: 'student', icon: 'cap', title: 'Student', blurb: 'Learn with courses, labs, quizzes and the AI tutor.', tint: 'var(--c-quantum, #6366f1)' },
  { id: 'instructor', icon: 'users', title: 'Instructor', blurb: 'Create courses, build tests and track your class.', tint: 'var(--c-ml, #10b981)' },
  { id: 'institute', icon: 'school', title: 'Institute', blurb: 'Manage your organisation and SSO members.', tint: 'var(--c-dl, #f59e0b)' },
];
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export async function render(root) {
  if (store.user) { navigate(roleHome(store.user.role)); return; }
  let mode = 'login';
  let role = sessionStorage.getItem('q3d-authrole') || 'student';
  let show = false;

  function view() {
    const r = ROLES.find((x) => x.id === role) || ROLES[0];
    const signup = mode === 'signup';
    root.innerHTML = `
      <div class="auth-wrap">
        <div class="auth-card card">
          <div class="auth-brand">
            <span class="brand-mark">${icon('sphere')}</span>
            <div><b>Q-3D Learn</b><small>${signup ? 'create your account' : 'welcome back — sign in'}</small></div>
          </div>

          <div class="seg auth-tabs" data-mode>
            <button data-m="login" class="${!signup ? 'active' : ''}">Log in</button>
            <button data-m="signup" class="${signup ? 'active' : ''}">Sign up</button>
          </div>

          <p class="faint small" style="margin:2px 0 10px">I am a…</p>
          <div class="auth-roles" data-roles>
            ${ROLES.map((x) => `
              <button type="button" class="auth-role ${x.id === role ? 'active' : ''}" data-role="${x.id}" style="--tint:${x.tint}">
                <span class="ar-ic">${icon(x.icon)}</span>
                <span class="ar-txt"><b>${x.title}</b><small>${esc(x.blurb)}</small></span>
              </button>`).join('')}
          </div>

          <form class="stack" data-form style="gap:11px;margin-top:14px" novalidate>
            ${signup ? `<label class="field">Full name
              <input class="input" name="name" maxlength="80" required autocomplete="name"
                placeholder="${role === 'institute' ? 'e.g. MIET Admin' : 'e.g. Divyanshi Panwar'}"></label>` : ''}
            <label class="field">Email
              <input class="input" name="email" type="email" maxlength="160" required autocomplete="email"
                placeholder="you@example.com"></label>
            <label class="field">Password
              <span style="position:relative;display:block">
                <input class="input" name="password" type="password" maxlength="128" required style="padding-right:64px"
                  autocomplete="${signup ? 'new-password' : 'current-password'}" placeholder="${signup ? 'At least 8 characters' : 'Your password'}">
                <button type="button" data-toggle style="position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:0;color:var(--text-3);cursor:pointer;font-size:.78rem">${show ? 'Hide' : 'Show'}</button>
              </span></label>
            ${signup ? `<label class="field">Confirm password
              <input class="input" name="confirm" type="password" maxlength="128" required autocomplete="new-password" placeholder="Re-enter your password"></label>
            ${role === 'student' ? `<label class="field">Classroom code <span class="faint">(optional)</span>
              <input class="input mono" name="code" maxlength="16" placeholder="DEMO42"></label>` : ''}` : ''}
            <div class="faint tiny" data-err style="color:var(--red,#e5484d);min-height:0;display:none"></div>
            <button class="btn btn-primary" type="submit" style="margin-top:4px">
              ${icon('arrowRight')} ${signup ? 'Create account' : 'Log in'} as ${r.title}
            </button>
          </form>

          <p class="faint tiny auth-foot">${icon('info')} ${signup
            ? 'Your password is stored securely (hashed, never in plain text).'
            : "New here? Switch to <b>Sign up</b> to create an account."}
            ${role === 'student' ? 'Students see courses, labs and study tools.'
              : role === 'instructor' ? 'Instructors see the teaching tools and the AI tutor.'
              : 'Institutes see the organisation dashboard.'}</p>
        </div>
      </div>`;
    hydrateIcons(root);
    wire();
  }

  function wire() {
    root.querySelector('[data-mode]').addEventListener('click', (e) => {
      const b = e.target.closest('[data-m]'); if (!b) return; mode = b.dataset.m; view();
    });
    root.querySelector('[data-roles]').addEventListener('click', (e) => {
      const b = e.target.closest('[data-role]'); if (!b) return;
      role = b.dataset.role; sessionStorage.setItem('q3d-authrole', role); view();
    });
    const form = root.querySelector('[data-form]');
    const errBox = form.querySelector('[data-err]');
    const toggle = form.querySelector('[data-toggle]');
    if (toggle) toggle.addEventListener('click', () => { show = !show; const p = form.password; p.type = show ? 'text' : 'password'; toggle.textContent = show ? 'Hide' : 'Show'; });
    setTimeout(() => (form.name || form.email).focus(), 40);

    const fail = (m) => { errBox.textContent = m; errBox.style.display = 'block'; };
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errBox.style.display = 'none';
      const email = (form.email.value || '').trim().toLowerCase();
      const password = form.password.value || '';
      if (!EMAIL_RE.test(email)) return fail('Please enter a valid email address.');
      if (mode === 'signup') {
        const name = (form.name.value || '').trim();
        if (!name) return fail('Please enter your name.');
        if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password))
          return fail('Password must be at least 8 characters and include a letter and a number.');
        if (password !== form.confirm.value) return fail('Passwords do not match.');
      } else if (!password) { return fail('Please enter your password.'); }

      const btn = form.querySelector('button[type=submit]'); btn.disabled = true;
      try {
        let user;
        if (mode === 'signup') {
          user = await api.signup({ name: form.name.value.trim(), email, password, role,
            classroom_code: role === 'student' ? (form.code?.value.trim().toUpperCase() || null) : null });
        } else {
          user = await api.login({ email, password });
        }
        store.set('user', user);
        toast(`Welcome, ${esc(user.name)}!`, 'success');
        await refreshAfterLogin();
        navigate(roleHome(user.role));
      } catch (err) { btn.disabled = false; fail(err.message || 'Something went wrong. Please try again.'); }
    });
  }

  view();
}
