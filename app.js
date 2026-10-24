(function () {
  const C = window.TodoCore;
  const $ = (s) => document.querySelector(s);
  const els = {
    login: $('#login'), loginForm: $('#login-form'), email: $('#email'), password: $('#password'), loginBtn: $('#login-btn'), loginErr: $('#login-error'),
    app: $('#app'), addForm: $('#add-form'),
    date: $('#date-label'), count: $('#count-pill'),
    todayList: $('#today-list'), todayEmpty: $('#today-empty'),
    doneWrap: $('#done-wrap'), doneList: $('#done-list'),
    upList: $('#upcoming-list'), upCount: $('#up-count'), upEmpty: $('#upcoming-empty'),
    text: $('#new-todo'), due: $('#new-due'), hint: $('#due-hint'),
    status: $('#sync-status'), logout: $('#logout-btn'),
  };

  let today = C.localToday();
  const LS_KEY = 'todotab.data';

  const store = new window.TodoStore({
    url: window.TODO_CONFIG.supabaseUrl,
    key: window.TODO_CONFIG.supabaseKey,
    loadLocal: async () => { try { return JSON.parse(localStorage.getItem(LS_KEY)) || { items: [] }; } catch (e) { return { items: [] }; } },
    saveLocal: (d) => { try { localStorage.setItem(LS_KEY, JSON.stringify(d)); } catch (e) {} },
    onChange: render,
    onAuth: (session) => {
      const on = !!session;
      els.login.hidden = on; els.app.hidden = !on; els.addForm.hidden = !on;
      if (on) { els.loginErr.textContent = ''; els.password.value = ''; }
    },
    onStatus: setStatus,
  });

  function setStatus(s) {
    const ok = s === 'SUBSCRIBED' || s === 'synced';
    const err = s === 'error' || s === 'CHANNEL_ERROR' || s === 'TIMED_OUT';
    els.status.classList.toggle('ok', ok);
    els.status.classList.toggle('err', err);
    els.status.querySelector('span').textContent = err ? '연결 안 됨 · 다시 열면 재시도' : ok ? 'PC와 연동 중' : '동기화 중…';
  }

  function itemEl(t, kind) {
    const row = document.createElement('div');
    row.className = 'item' + (t.done ? ' done' : '');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.id = 'cb-' + t.id; cb.checked = !!t.done;
    cb.addEventListener('change', () => store.toggle(t.id, today));
    const label = document.createElement('label');
    label.htmlFor = cb.id; label.textContent = t.text;
    row.append(cb, label);
    if (t.due) {
      const d = C.daysFromToday(t.due, today);
      if (kind === 'upcoming') {
        const when = document.createElement('span'); when.className = 'when';
        const b = document.createElement('b'); b.textContent = C.shortDate(t.due);
        const s = document.createElement('small'); s.textContent = C.chipFor(d);
        when.append(b, s); row.append(when);
      } else if (kind === 'today' && d <= 0) {
        const chip = document.createElement('span'); chip.className = 'chip'; chip.textContent = C.chipFor(d);
        row.append(chip);
      }
    }
    const del = document.createElement('button');
    del.className = 'del'; del.type = 'button'; del.setAttribute('aria-label', '삭제'); del.textContent = '×';
    del.addEventListener('click', () => { if (confirm(`"${t.text}" 삭제할까요?`)) store.remove(t.id); });
    row.append(del);
    return row;
  }

  function render() {
    const g = C.classify(store.items, today);
    els.date.textContent = C.headerDate(today);
    els.count.textContent = `${g.today.length} 남음`;
    els.count.classList.toggle('zero', g.today.length === 0);
    els.todayList.replaceChildren(...g.today.map(({ t }) => itemEl(t, 'today')));
    els.todayEmpty.hidden = g.today.length > 0;
    els.doneWrap.hidden = g.done.length === 0;
    els.doneList.replaceChildren(...g.done.map(({ t }) => itemEl(t, 'done')));
    els.upList.replaceChildren(...g.upcoming.map(({ t }) => itemEl(t, 'upcoming')));
    els.upCount.textContent = `${g.upcoming.length}건`;
    els.upEmpty.hidden = g.upcoming.length > 0;
    updateDueHint();
  }
  function updateDueHint() {
    const v = els.due.value;
    els.hint.textContent = !v ? '비우면 오늘 할 일로' : (C.daysFromToday(v, today) <= 0 ? '→ 오늘 할 일로' : '→ 해야 할 일로');
  }

  els.addForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = els.text.value.trim();
    if (!text) return;
    store.add(text, els.due.value || null);
    els.text.value = ''; els.due.value = ''; updateDueHint();
  });
  els.due.addEventListener('change', updateDueHint);
  els.due.addEventListener('input', updateDueHint);

  els.loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    els.loginBtn.disabled = true; els.loginErr.textContent = '';
    try { await store.signIn(els.email.value.trim(), els.password.value); }
    catch (err) { els.loginErr.textContent = /invalid/i.test(err.message) ? '이메일 또는 비밀번호가 맞지 않아요' : ('로그인 실패: ' + err.message); }
    finally { els.loginBtn.disabled = false; }
  });
  els.logout.addEventListener('click', () => { if (confirm('로그아웃할까요? (할 일은 서버에 그대로 남아요)')) store.signOut(); });

  // 날짜 바뀌면(자정 지나서 다시 열었을 때) 재분류 + 전날 완료 정리
  function checkDay() {
    const t = C.localToday();
    if (t !== today) { today = t; store.cleanupOldDone(today); render(); }
  }
  setInterval(checkDay, 30 * 1000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkDay(); });

  store.init().then(() => { store.cleanupOldDone(today); render(); });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
})();
