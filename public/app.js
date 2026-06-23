// Shared client helpers for Smart QR Manager

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) throw new Error((data && data.error) || `请求失败 (${res.status})`);
  return data;
}

async function getMe() {
  try { return await api('/api/auth/me'); }
  catch { return null; }
}

// Redirect to login if not authenticated; returns the user otherwise.
async function requireAuth() {
  const me = await getMe();
  if (!me) { location.href = '/login.html'; return null; }
  return me;
}

function qs(name) {
  return new URLSearchParams(location.search).get(name);
}

function showMsg(el, text, type = 'err') {
  el.textContent = text;
  el.className = `msg show ${type}`;
}

function fmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleString('zh-CN', { hour12: false });
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Render the shared top navigation into #nav
async function renderNav(active) {
  const el = document.getElementById('nav');
  if (!el) return;
  const me = await getMe();
  const link = (href, label, key) =>
    `<a href="${href}" class="${active === key ? 'active' : ''}">${label}</a>`;
  let right;
  if (me) {
    right =
      link('/dashboard.html', '二维码', 'dashboard') +
      link('/forms.html', '表单', 'forms') +
      link('/profile.html', '我的信息', 'profile') +
      `<a href="#" id="logoutBtn">退出</a>`;
  } else {
    right = link('/login.html', '登录', 'login');
  }
  el.innerHTML = `
    <div class="nav-inner">
      <a class="brand" href="/"><span class="dot">▦</span> Smart QR Manager</a>
      <nav class="nav-links">${right}</nav>
    </div>`;
  const lo = document.getElementById('logoutBtn');
  if (lo) lo.addEventListener('click', async (e) => {
    e.preventDefault();
    await api('/api/auth/logout', { method: 'POST' });
    location.href = '/';
  });
}
