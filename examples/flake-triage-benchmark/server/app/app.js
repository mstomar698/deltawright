// URL-driven fixture SPA. `?fault=<id>&seed=<n>` (before the hash) selects one injected fault; the app
// applies client-side faults itself and echoes the fault to the API for server-side ones. Deterministic
// except `flaky-appear` (intentionally random). Each flow has a clean path + its relevant fault variants.
(function () {
  const params = new URLSearchParams(location.search);
  const FAULT = params.get('fault') || 'clean';
  const q = (sel, r = document) => r.querySelector(sel);
  const root = () => document.getElementById('root');
  const api = (path) => fetch(path + (path.includes('?') ? '&' : '?') + 'fault=' + FAULT);
  const el = (html) => { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstElementChild; };

  // --- LOGIN: submit enabled iff both fields non-empty. Fault: disabled-stuck (never enables). -----
  function login() {
    root().innerHTML = `<h2>Login</h2>
      <label>Username</label><input id="username" />
      <label>Password</label><input id="password" type="password" />
      <div style="margin-top:12px"><button id="submit" disabled>Sign in</button></div>
      <p id="login-result"></p>`;
    const u = q('#username'), p = q('#password'), b = q('#submit');
    const sync = () => { if (FAULT !== 'disabled-stuck') b.disabled = !(u.value && p.value); };
    u.addEventListener('input', sync); p.addEventListener('input', sync);
    b.addEventListener('click', () => { q('#login-result').innerHTML = '<span class="ok" id="signed-in">Signed in</span>'; });
  }

  // --- DASHBOARD: async table + filter + sort + paginate. Fault: flaky-appear (random load delay). --
  function dashboard() {
    root().innerHTML = `<h2>Dashboard</h2>
      <input id="filter" placeholder="filter…" />
      <div id="loading">loading…</div><div id="grid"></div>
      <div style="margin-top:8px"><button id="prev">Prev</button> <span id="page">1</span> <button id="next">Next</button></div>`;
    let all = [], page = 0, sortKey = 'id', asc = true;
    const PER = 10;
    const render = () => {
      const term = (q('#filter').value || '').toLowerCase();
      const rows = all.filter((r) => r.name.toLowerCase().includes(term))
        .sort((a, b) => (a[sortKey] > b[sortKey] ? 1 : -1) * (asc ? 1 : -1));
      const slice = rows.slice(page * PER, page * PER + PER);
      q('#grid').innerHTML = `<table id="tbl"><thead><tr>
        <th data-sort="id">ID</th><th data-sort="name">Name</th><th data-sort="status">Status</th><th data-sort="amount">Amount</th><th>Actions</th>
        </tr></thead><tbody>${slice.map((r) => `<tr data-id="${r.id}">
          <td>${r.id}</td><td class="name">${r.name}</td><td>${r.status}</td><td>${r.amount}</td>
          <td class="row-actions"><button class="view">View</button><button class="del">Delete</button></td></tr>`).join('')}</tbody></table>`;
      q('#page').textContent = String(page + 1);
      q('#grid').querySelectorAll('th[data-sort]').forEach((th) => th.addEventListener('click', () => {
        const k = th.dataset.sort; asc = sortKey === k ? !asc : true; sortKey = k; render();
      }));
      q('#grid').querySelectorAll('.del').forEach((btn) => btn.addEventListener('click', (e) => {
        e.target.closest('tr').remove();
      }));
    };
    const load = () => api('/api/list').then((r) => r.json()).then((d) => {
      all = d.rows; q('#loading').style.display = 'none'; render();
      q('#filter').addEventListener('input', () => { page = 0; render(); });
      q('#next').addEventListener('click', () => { page++; render(); });
      q('#prev').addEventListener('click', () => { if (page > 0) page--; render(); });
    });
    if (FAULT === 'flaky-appear') setTimeout(load, Math.random() * 1200); else load();
  }

  // --- RECORD: masked/debounced inputs + async save. Faults: input-*, backend-500, rpc-settle. ------
  function record() {
    root().innerHTML = `<h2>Record</h2>
      <label>Card</label><input id="card" />
      <label>Phone</label><input id="phone" />
      <label>Notes</label><input id="notes" />
      <div style="margin-top:12px"><button id="save">Save</button></div>
      <p id="save-result"></p>`;
    const card = q('#card'), notes = q('#notes');
    // mask-truncate: card is capped at 4 chars (silent loss past the cap).
    if (FAULT === 'input-mask-truncate') card.addEventListener('input', () => { if (card.value.length > 4) card.value = card.value.slice(0, 4); });
    // debounce-clear: 200ms after the last keystroke, notes is wiped.
    if (FAULT === 'input-debounce-clear') {
      let t; notes.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { notes.value = ''; }, 200); });
    }
    let poll;
    q('#save').addEventListener('click', async () => {
      if (FAULT === 'rpc-settle') poll = setInterval(() => api('/api/poll'), 120); // keep network non-idle
      const res = await api('/api/save');
      const show = () => {
        if (res.ok) q('#save-result').innerHTML = '<span class="ok" id="save-ok">Saved</span>';
        else q('#save-result').innerHTML = '<span class="err" id="save-err">Save failed</span>';
        if (poll) clearInterval(poll);
      };
      if (FAULT === 'rpc-settle') setTimeout(show, 600); else show();
    });
  }

  // --- MODAL: confirm dialog. Fault: covered-overlay (glass over #confirm + a look-alike decoy). -----
  function modal() {
    root().innerHTML = `<h2>Modal</h2><button id="open">Open dialog</button><div id="modal-result"></div><div id="host" style="position:relative"></div>`;
    q('#open').addEventListener('click', () => {
      const host = q('#host');
      host.innerHTML = `<div role="dialog" aria-label="Confirm" style="position:relative;border:1px solid #333;padding:16px;margin-top:10px;display:inline-block">
        <p>Are you sure?</p>
        <button id="confirm">Confirm</button> <button id="cancel">Cancel</button>
        ${FAULT === 'covered-overlay' ? '<button id="confirm-decoy" style="margin-left:10px">Confirm</button>' : ''}
      </div>`;
      q('#confirm').addEventListener('click', () => { q('#modal-result').innerHTML = '<span class="ok" id="confirmed">Confirmed</span>'; });
      if (FAULT === 'covered-overlay') {
        const btn = q('#confirm'), r = btn.getBoundingClientRect();
        const glass = el(`<div class="glass"></div>`);
        Object.assign(glass.style, { left: r.left + window.scrollX + 'px', top: r.top + window.scrollY + 'px', width: r.width + 'px', height: r.height + 'px' });
        document.body.appendChild(glass); // intercepts the click on the real Confirm
      }
    });
  }

  // --- WIZARD: 3 async-gated steps. Fault: app-js-error (step-1 next handler throws). --------------
  function wizard() {
    root().innerHTML = `<h2>Wizard</h2><div id="wiz"><button id="next1">Next</button></div><p id="wiz-result"></p>`;
    q('#next1').addEventListener('click', async () => {
      if (FAULT === 'app-js-error') { throw new Error('wizard step handler blew up'); }
      await api('/api/validate').then((r) => r.json());
      q('#wiz').innerHTML = `<button id="next2">Next</button>`;
      q('#next2').addEventListener('click', async () => {
        await api('/api/validate').then((r) => r.json());
        q('#wiz-result').innerHTML = '<span class="ok" id="wiz-done">Done</span>';
      });
    });
  }

  // --- SETTINGS: toggles + a live-region status. Fault: offscreen (#apply positioned off-screen). ---
  function settings() {
    root().innerHTML = `<h2>Settings</h2>
      <label><input type="checkbox" id="toggle-a" /> Option A</label>
      <label><input type="checkbox" id="toggle-b" /> Option B</label>
      <div style="margin-top:12px"><button id="apply" ${FAULT === 'offscreen' ? 'style="position:fixed;left:-9999px;top:-9999px"' : ''}>Apply</button></div>
      <div id="status" role="status" aria-live="polite"></div>`;
    q('#apply').addEventListener('click', () => { q('#status').textContent = 'Saved'; });
  }

  // --- DETAIL: load a panel from a SLOW API. Fault: backend-slow-500 (5xx arrives ~500ms after click). --
  function detail() {
    root().innerHTML = `<h2>Detail</h2><button id="load-detail">Load detail</button>
      <div id="spinner" style="display:none">loading…</div><div id="detail-result"></div>`;
    q('#load-detail').addEventListener('click', async () => {
      q('#spinner').style.display = 'block';
      // Realistic pattern: the UI POLLS the detail endpoint while waiting for it to succeed. Under
      // backend-slow-500 every poll 500s, so 5xx request-starts keep landing DURING the failing
      // assertion's window (not just at click time) → diagnose-trace can window-correlate them.
      const attempt = async () => {
        const res = await api('/api/detail');
        if (res.ok) { const d = await res.json(); q('#spinner').style.display = 'none'; q('#detail-result').innerHTML = `<span class="ok" id="detail">${d.detail}</span>`; return true; }
        return false;
      };
      if (await attempt()) return;
      const poll = setInterval(async () => { if (await attempt()) clearInterval(poll); }, 200);
    });
  }

  const routes = { '/login': login, '/dashboard': dashboard, '/record': record, '/modal': modal, '/wizard': wizard, '/settings': settings, '/detail': detail };
  function route() { (routes[location.hash.replace(/^#/, '')] || login)(); }
  window.addEventListener('hashchange', route);
  route();
})();
