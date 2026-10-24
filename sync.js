/* TodoStore: 로컬 저장 + Supabase 동기화 (로그인 안 했으면 로컬만 사용)
 * 의존: window.supabase (UMD), window.TodoCore
 * 저장 형식: { items: [...], pending: { upserts: [...ids], deletes: [...ids] } }
 * item: { id, text, due, done, doneAt, createdAt, updatedAt, synced }
 */
(function (root) {
  const SB = root.supabase;

  class TodoStore {
    constructor(opts) {
      this.url = opts.url;
      this.key = opts.key;
      this.loadLocal = opts.loadLocal;   // async () => ({items, pending}) | items[]
      this.saveLocal = opts.saveLocal;   // (data) => void
      this.onChange = opts.onChange || (() => {});
      this.onAuth = opts.onAuth || (() => {});
      this.onStatus = opts.onStatus || (() => {});
      this.authStorage = opts.authStorage || null;
      this.items = [];
      this.pending = { upserts: new Set(), deletes: new Set() };
      this.client = null;
      this.session = null;
      this.channel = null;
      this.timer = null;
      this.syncing = false;
    }

    // ── 시작 ───────────────────────────────────────────────
    async init() {
      const data = await this.loadLocal();
      if (Array.isArray(data)) { this.items = data; }
      else if (data && typeof data === 'object') {
        this.items = Array.isArray(data.items) ? data.items : [];
        const p = data.pending || {};
        this.pending.upserts = new Set(p.upserts || []);
        this.pending.deletes = new Set(p.deletes || []);
      }
      this.onChange();

      if (!SB || !this.url || !this.key) return;
      const authOpts = {
        persistSession: true, autoRefreshToken: true, detectSessionInUrl: false,
        // iOS 홈 화면 앱에서 navigator.locks가 멈추는 문제 회피: 잠금 없이 바로 실행
        lock: async (_name, _timeout, fn) => fn(),
      };
      if (this.authStorage) authOpts.storage = this.authStorage;
      this.client = SB.createClient(this.url, this.key, { auth: authOpts });

      // 세션 복구: SDK 저장소가 비어 있으면 우리가 따로 보관한 토큰으로 되살림
      const BK = 'todotab.session';
      const storage = this.authStorage || (typeof localStorage !== 'undefined' ? localStorage : null);
      const backup = (sess) => { try { if (!storage) return; if (sess) storage.setItem(BK, JSON.stringify({ a: sess.access_token, r: sess.refresh_token })); else storage.removeItem(BK); } catch (e) {} };
      let got = null;
      try { got = (await this.client.auth.getSession()).data.session; } catch (e) { got = null; }
      if (!got && storage) {
        try {
          const raw = storage.getItem(BK);
          if (raw) {
            const { a, r } = JSON.parse(raw);
            const { data } = await this.client.auth.setSession({ access_token: a, refresh_token: r });
            got = data ? data.session : null;
          }
        } catch (e) { got = null; }
      }
      this.session = got;
      backup(this.session);
      this.client.auth.onAuthStateChange((_evt, session) => backup(session));
      this.onAuth(this.session);
      this.client.auth.onAuthStateChange((_evt, session) => {
        const had = !!this.session;
        this.session = session;
        this.onAuth(session);
        if (session && !had) this.startSync();
        if (!session && had) this.stopSync();
      });
      if (this.session) this.startSync();
    }

    get user() { return this.session ? this.session.user : null; }
    get online() { return !!this.session; }

    async signIn(email, password) {
      if (!this.client) throw new Error('동기화 설정이 없습니다');
      const { error } = await this.client.auth.signInWithPassword({ email, password });
      if (error) throw error;
    }
    async signOut() {
      if (!this.client) return;
      await this.client.auth.signOut();
    }

    // ── 동기화 ─────────────────────────────────────────────
    startSync() {
      this.stopSync();
      this.pullAll().catch(() => {});
      this.channel = this.client.channel('todos-sync')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'todos' }, (p) => this._onRealtime(p))
        .subscribe((status) => this.onStatus(status));
      this.timer = setInterval(() => this.pullAll().catch(() => {}), 60 * 1000);
      // 창이 다시 보일 때 즉시 당겨오기
      if (typeof document !== 'undefined') {
        this._vis = () => { if (document.visibilityState === 'visible') this.pullAll().catch(() => {}); };
        document.addEventListener('visibilitychange', this._vis);
      }
    }
    stopSync() {
      if (this.channel) { this.client.removeChannel(this.channel); this.channel = null; }
      if (this.timer) { clearInterval(this.timer); this.timer = null; }
      if (this._vis) { document.removeEventListener('visibilitychange', this._vis); this._vis = null; }
    }

    _toRow(it) {
      return {
        id: it.id, text: it.text, due: it.due || null, done: !!it.done, done_at: it.doneAt || null,
        created_at: new Date(it.createdAt || Date.now()).toISOString(),
        updated_at: new Date(it.updatedAt || Date.now()).toISOString(),
      };
    }
    _fromRow(r) {
      return {
        id: r.id, text: r.text, due: r.due || null, done: !!r.done, doneAt: r.done_at || null,
        createdAt: Date.parse(r.created_at) || Date.now(),
        updatedAt: Date.parse(r.updated_at) || Date.now(),
        synced: true,
      };
    }

    async pullAll() {
      if (!this.session || this.syncing) return;
      this.syncing = true;
      try {
        await this._flushPending();
        const { data, error } = await this.client.from('todos').select('*');
        if (error) throw error;
        const remote = data.map((r) => this._fromRow(r));
        const rmap = new Map(remote.map((r) => [r.id, r]));
        const lmap = new Map(this.items.map((l) => [l.id, l]));
        const next = [];
        for (const r of remote) {
          if (this.pending.deletes.has(r.id)) continue;
          const l = lmap.get(r.id);
          if (!l) next.push(r);
          else if ((l.updatedAt || 0) > r.updatedAt) { next.push(l); this.pending.upserts.add(l.id); }
          else next.push(r);
        }
        for (const l of this.items) {
          if (rmap.has(l.id)) continue;
          if (this.pending.deletes.has(l.id)) continue;
          if (!l.synced || this.pending.upserts.has(l.id)) { next.push(l); this.pending.upserts.add(l.id); }
          // synced였는데 서버에 없음 → 다른 기기에서 삭제됨 → 버림
        }
        this.items = next;
        this._persist();
        this.onChange();
        await this._flushPending();
        this.onStatus('synced');
      } catch (e) {
        this.onStatus('error');
      } finally {
        this.syncing = false;
      }
    }

    async _flushPending() {
      if (!this.session) return;
      if (this.pending.deletes.size) {
        const ids = [...this.pending.deletes];
        const { error } = await this.client.from('todos').delete().in('id', ids);
        if (!error) { this.pending.deletes.clear(); this._persist(); }
      }
      if (this.pending.upserts.size) {
        const rows = [...this.pending.upserts].map((id) => this.items.find((x) => x.id === id)).filter(Boolean).map((it) => this._toRow(it));
        if (rows.length) {
          const { error } = await this.client.from('todos').upsert(rows, { onConflict: 'id' });
          if (!error) {
            for (const r of rows) { const it = this.items.find((x) => x.id === r.id); if (it) it.synced = true; }
            this.pending.upserts.clear(); this._persist();
          }
        } else { this.pending.upserts.clear(); this._persist(); }
      }
    }

    _onRealtime(p) {
      if (p.eventType === 'DELETE') {
        const id = p.old && p.old.id;
        if (!id) return;
        const before = this.items.length;
        this.items = this.items.filter((x) => x.id !== id);
        if (this.items.length !== before) { this._persist(); this.onChange(); }
        return;
      }
      const r = this._fromRow(p.new);
      if (this.pending.deletes.has(r.id)) return;
      const i = this.items.findIndex((x) => x.id === r.id);
      if (i < 0) this.items.push(r);
      else if ((this.items[i].updatedAt || 0) <= r.updatedAt) this.items[i] = r;
      else return;
      this._persist();
      this.onChange();
    }

    // ── 변경 ───────────────────────────────────────────────
    _persist() {
      this.saveLocal({
        items: this.items,
        pending: { upserts: [...this.pending.upserts], deletes: [...this.pending.deletes] },
      });
    }
    _touch(it) {
      it.updatedAt = Date.now();
      it.synced = false;
      this.pending.upserts.add(it.id);
      this._persist();
      this.onChange();
      this._flushPending().catch(() => this.onStatus('error'));
    }
    add(text, due) {
      const now = Date.now();
      const it = { id: root.TodoCore.newId(), text, due: due || null, done: false, doneAt: null, createdAt: now, updatedAt: now, synced: false };
      this.items.push(it);
      this._touch(it);
      return it;
    }
    toggle(id, today) {
      const it = this.items.find((x) => x.id === id);
      if (!it) return;
      it.done = !it.done;
      it.doneAt = it.done ? today : null;
      this._touch(it);
    }
    remove(id) {
      const before = this.items.length;
      this.items = this.items.filter((x) => x.id !== id);
      if (this.items.length === before) return;
      this.pending.upserts.delete(id);
      this.pending.deletes.add(id);
      this._persist();
      this.onChange();
      this._flushPending().catch(() => this.onStatus('error'));
    }
    // 전날 이전에 완료한 항목 정리 (0시)
    cleanupOldDone(today) {
      const old = this.items.filter((t) => t.done && t.doneAt && t.doneAt < today);
      if (!old.length) return;
      for (const t of old) { this.pending.upserts.delete(t.id); this.pending.deletes.add(t.id); }
      this.items = this.items.filter((t) => !old.includes(t));
      this._persist();
      this.onChange();
      this._flushPending().catch(() => {});
    }
  }

  root.TodoStore = TodoStore;
})(typeof window !== 'undefined' ? window : globalThis);
