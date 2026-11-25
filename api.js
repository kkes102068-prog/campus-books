// 資料層:有設定 Supabase 就用真實後端,沒設定則使用瀏覽器本機的示範模式。
(function () {
  'use strict';

  const cfg = window.APP_CONFIG || {};
  const DEMO = !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY;
  // 登入狀態記在這支手機/瀏覽器:最後一次「實際登入」超過 3 天就要重新登入(me() 會檢查)。
  const LOGIN_TTL = 3 * 24 * 3600 * 1000;
  const LOGIN_KEY = 'cb_login_at';
  const markLogin = () => { try { localStorage.setItem(LOGIN_KEY, String(Date.now())); } catch (e) { /* ignore */ } };
  const sb = DEMO ? null : window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { storage: window.localStorage, persistSession: true, autoRefreshToken: true }
  });
  const BUCKET = 'book-images';

  function compressImage(file, maxSide, quality) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob((b) => (b ? resolve(b) : reject(new Error('圖片處理失敗'))), 'image/jpeg', quality);
      };
      img.onerror = () => reject(new Error('無法讀取圖片'));
      img.src = url;
    });
  }

  const unwrap = ({ data, error }) => { if (error) throw error; return data; };

  // =========================================================
  // 真實後端(Supabase)
  // =========================================================
  const BOOK_SELECT = '*'; // 不帶出賣家的暱稱與頭像(匿名)
  const WISH_SELECT = '*'; // 不帶出許願者的暱稱與頭像(匿名)
  const THREAD_SELECT = '*, book:books(title,image_url,price,status,meetup_place), wish:wishes(title),' +
    ' buyer:profiles!buyer_id(display_name,picture_url), seller:profiles!seller_id(display_name,picture_url)';

  function b64ToBytes(b64) {
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }

  async function callFn(name, body) {
    const { data, error } = await sb.functions.invoke(name, { body });
    if (error) {
      let msg = error.message;
      try { msg = (await error.context.json()).error || msg; } catch (e) { /* ignore */ }
      throw new Error(msg);
    }
    return data;
  }
  const DEFAULT_PLACES = ['圖書館門口', '學生餐廳', '各系館一樓大廳', '校門口警衛室'];

  const real = {
    async me() {
      const { data: { session } } = await sb.auth.getSession();
      if (!session) return null;
      let at = 0;
      try { at = Number(localStorage.getItem(LOGIN_KEY)) || 0; } catch (e) { /* ignore */ }
      if (!at) { markLogin(); at = Date.now(); }  // 舊版登入的人:從現在開始算 3 天
      if (Date.now() - at > LOGIN_TTL) { await sb.auth.signOut(); try { localStorage.removeItem(LOGIN_KEY); } catch (e) { /* ignore */ } return null; }
      const uid = session.user.id;
      const [p, adm, priv, cons] = await Promise.all([
        sb.from('profiles').select('id,display_name,picture_url,banned,ban_reason').eq('id', uid).maybeSingle(),
        sb.rpc('is_admin'),
        sb.from('user_private').select('department,email,notify_email,name_set,student_verified,school_email,own_login_set,student_no,verify_status,verify_note,real_name,enroll_year').eq('user_id', uid).maybeSingle(),
        sb.rpc('my_consent_ok')
      ]);
      if (!p.data) { await sb.auth.signOut(); return null; }
      return { id: uid, name: p.data.display_name, picture: p.data.picture_url || '', banned: p.data.banned, isAdmin: !!adm.data, banReason: p.data.ban_reason || '', verified: !!adm.data || !!(priv.data && priv.data.student_verified), schoolEmail: (priv.data && priv.data.school_email) || '', studentNo: (priv.data && priv.data.student_no) || '', realName: (priv.data && priv.data.real_name) || '', enrollYear: (priv.data && priv.data.enroll_year) || 0, verifyStatus: (priv.data && priv.data.verify_status) || 'none', verifyNote: (priv.data && priv.data.verify_note) || '', nameSet: !!(priv.data && priv.data.name_set), department: (priv.data && priv.data.department) || '', consented: !!cons.data, ownLoginSet: !!(priv.data && priv.data.own_login_set), hasEmail: !!(priv.data && priv.data.email), notifyEmail: !!(priv.data && priv.data.notify_email) };
    },

    // 導向 LINE 登入頁
    login() {
      if (!cfg.LINE_CHANNEL_ID) { alert('尚未設定 LINE_CHANNEL_ID(config.js)'); return; }
      const state = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)) + Date.now();
      const redirect = new URL('./', location.href).href; // 網站根目錄,需登錄為 LINE Callback URL
      // iPad / iPhone 經 QR code 或 LINE App 導回時可能是新分頁,sessionStorage 會是空的,所以兩邊都存
      [sessionStorage, localStorage].forEach((st) => {
        try {
          st.setItem('line_state', state);
          st.setItem('line_redirect', redirect);
          st.setItem('line_return', location.href);
        } catch (e) { /* 私密模式可能不能寫 */ }
      });
      const q = new URLSearchParams({
        response_type: 'code', client_id: cfg.LINE_CHANNEL_ID, redirect_uri: redirect,
        state: state, scope: cfg.LINE_REQUEST_EMAIL ? 'profile openid email' : 'profile openid'
      });
      if (cfg.LINE_BOT_PROMPT) q.set('bot_prompt', 'normal');
      // 主畫面 App 內:不要自動跳去 LINE App(否則登入結果會回到 Safari,主畫面 App 仍是未登入)。此參數效果尚待實機驗證
      if (navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)) q.set('disable_auto_login', 'true');
      location.href = 'https://access.line.me/oauth2/v2.1/authorize?' + q.toString();
    },

    // LINE 導回後處理 ?code=...;成功後會導回登入前的頁面
    async handleCallback() {
      const p = new URLSearchParams(location.search);
      if (!p.get('code') || !p.get('state')) return;
      const get = (k) => { try { return sessionStorage.getItem(k) || localStorage.getItem(k); } catch (e) { return null; } };
      const expected = get('line_state');
      const redirect = get('line_redirect');
      const back = get('line_return');
      ['line_state', 'line_redirect', 'line_return'].forEach((k) => {
        try { sessionStorage.removeItem(k); localStorage.removeItem(k); } catch (e) { /* ignore */ }
      });
      history.replaceState({}, '', location.pathname);
      if (!expected || p.get('state') !== expected) throw new Error('登入驗證失敗,請重新登入');

      const { data, error } = await sb.functions.invoke(cfg.FN_LOGIN || 'line-login', {
        body: { code: p.get('code'), redirect_uri: redirect }
      });
      if (error) {
        let msg = error.message;
        try { msg = (await error.context.json()).error || msg; } catch (e) { /* ignore */ }
        throw new Error(msg);
      }
      const r = await sb.auth.verifyOtp({ token_hash: data.token_hash, type: 'magiclink' });
      if (r.error) throw r.error;
      markLogin();
      if (back && back !== location.href) location.replace(back);
    },

    // 登入碼:已登入者產生(5 分鐘、一次性),另一個環境(如主畫面 App)輸入後登入
    // ----- 在校生驗證 -----
    async saveBasicInfo(name, dept, year) { unwrap(await sb.rpc('save_basic_info', { p_name: name, p_dept: dept, p_year: Number(year) })); },
    async submitStudentCard(no, file) {
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error('請先登入');
      const blob = await compressImage(file, 1600, 0.85);
      const path = session.user.id + '/' + Date.now() + '.jpg';
      const up = await sb.storage.from('student-cards').upload(path, blob, { contentType: 'image/jpeg' });
      if (up.error) throw up.error;
      const r = await sb.rpc('submit_student_card', { p_no: no, p_path: path });
      if (r.error) { await sb.storage.from('student-cards').remove([path]).catch(() => {}); throw r.error; }
    },
    async checkBanned(uid) {
      const r = await sb.from('profiles').select('banned,ban_reason').eq('id', uid).maybeSingle();
      return r.data ? { banned: !!r.data.banned, reason: r.data.ban_reason || '' } : { banned: false, reason: '' };
    },
    // ----- 檢舉、評價、面交地點 -----
    async reportBook(id, reason, detail) { unwrap(await sb.rpc('report_book', { p_book: id, p_reason: reason, p_detail: detail || '' })); },
    async reportThreadUser(tid, reason, detail) { unwrap(await sb.rpc('report_thread_user', { p_thread: tid, p_reason: reason, p_detail: detail || '' })); },
    async rateSeller(tid, stars, comment) { unwrap(await sb.rpc('rate_seller', { p_thread: tid, p_stars: stars, p_comment: comment || '' })); },
    async myRatedThreads(uid) { return (unwrap(await sb.from('ratings').select('thread_id').eq('rater_id', uid)) || []).map((r) => r.thread_id); },
    async myRating() {
      const rows = unwrap(await sb.rpc('my_rating'));
      return rows && rows[0] && rows[0].cnt ? { avg: Number(rows[0].avg_stars), cnt: rows[0].cnt } : { avg: null, cnt: 0 };
    },
    async listPlaces() {
      try {
        const rows = unwrap(await sb.from('meetup_places').select('name,sort,active').order('sort').order('id'));
        const names = (rows || []).filter((r) => r.active).map((r) => r.name);
        return names.length ? names : DEFAULT_PLACES;
      } catch (e) { return DEFAULT_PLACES; }
    },
    async createLoginCode() { return unwrap(await sb.rpc('create_login_code')); },
    async loginWithCode(c) {
      const { data, error } = await sb.functions.invoke(cfg.FN_LOGIN || 'line-login', { body: { login_code: c } });
      if (error) {
        let msg = error.message;
        try { msg = (await error.context.json()).error || msg; } catch (e) { /* ignore */ }
        throw new Error(msg);
      }
      const r = await sb.auth.verifyOtp({ token_hash: data.token_hash, type: 'magiclink' });
      if (r.error) throw r.error;
      markLogin();
    },
    // Email + 密碼登入(認證成功後自己設定的帳號)
    async loginWithPassword(email, password) {
      const r = await sb.auth.signInWithPassword({ email: String(email).trim().toLowerCase(), password });
      if (r.error) throw new Error('Email 或密碼不正確');
      const b = await this.checkBanned(r.data.user.id);
      if (b.banned) { await sb.auth.signOut(); throw new Error('此帳號已被停權' + (b.reason ? '(原因:' + b.reason + ')' : '') + ',如有疑問請聯絡管理員'); }
      markLogin();
    },
    async setCredentials(email, password) { unwrap(await sb.rpc('set_my_credentials', { p_email: email, p_password: password })); },
    async logout() { await sb.auth.signOut(); },
    async setAvatar(v) { unwrap(await sb.rpc('set_my_avatar', { p_avatar: v })); },
    async setDepartment(d) { unwrap(await sb.rpc('set_my_department', { p_department: d })); },
    async setName(n) { unwrap(await sb.rpc('set_my_name', { p_name: n })); },
    async signConsent(version) { unwrap(await sb.rpc('sign_consent', { p_version: version })); },
    async listAnnouncements() {
      const rows = unwrap(await sb.from('announcements').select('id,title,body,link,created_at')
        .eq('active', true).or('expires_at.is.null,expires_at.gt.' + new Date().toISOString())
        .order('created_at', { ascending: false }).limit(10));
      return rows || [];
    },

    // ----- 未讀 -----
    async unreadCounts() {
      const rows = unwrap(await sb.rpc('unread_counts'));
      const map = {};
      (rows || []).forEach((r) => { map[r.thread_id] = Number(r.unread); });
      return map;
    },
    async markRead(tid) { unwrap(await sb.rpc('mark_thread_read', { p_thread: tid })); },

    // ----- 瀏覽器推播(Web Push)-----
    // 回傳:unsupported | denied | off | on
    async pushState() {
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window) || !cfg.VAPID_PUBLIC_KEY) return 'unsupported';
      if (Notification.permission === 'denied') return 'denied';
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg && (await reg.pushManager.getSubscription());
      return sub ? 'on' : 'off';
    },
    async enablePush() {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') throw new Error('你沒有允許通知權限');
      const reg = await navigator.serviceWorker.register('sw.js');
      await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(cfg.VAPID_PUBLIC_KEY) });
      const j = sub.toJSON();
      unwrap(await sb.rpc('save_push_subscription', { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth }));
    },
    async disablePush() {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg && (await reg.pushManager.getSubscription());
      if (!sub) return;
      await sb.rpc('remove_push_subscription', { p_endpoint: sub.endpoint });
      await sub.unsubscribe();
    },
    // 同一支瀏覽器換人登入時,把既有訂閱綁定到目前使用者
    async syncPush() {
      if ((await real.pushState()) !== 'on') return;
      const reg = await navigator.serviceWorker.getRegistration();
      const j = (await reg.pushManager.getSubscription()).toJSON();
      await sb.rpc('save_push_subscription', { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth });
    },
    async setNotifyEmail(on) { unwrap(await sb.rpc('set_notify_email', { p_on: !!on })); },

    async uploadImage(file) {
      const blob = await compressImage(file, 1000, 0.8);
      const path = Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.jpg';
      const { error } = await sb.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg' });
      if (error) throw error;
      return sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
    },

    async listBooks() {
      const [res, rt] = await Promise.all([
        sb.from('books').select(BOOK_SELECT).in('status', ['active', 'reserved', 'sold']).order('created_at', { ascending: false }).limit(500),
        sb.rpc('book_seller_ratings')
      ]);
      const rows = unwrap(res);
      const map = {};
      (rt.data || []).forEach((r) => { map[r.book_id] = { avg: Number(r.avg_stars), cnt: r.cnt }; });   // 還沒執行新的 SQL 時 rt.data 是空的,不影響使用
      return rows.map((b) => Object.assign(b, { rating: map[b.id] || null }));
    },
    async addBook(row) { unwrap(await sb.from('books').insert(row)); },
    async updateBookMeta(id, r) {
      unwrap(await sb.rpc('update_my_book_meta', { p_book: id, p_condition: r.condition || '', p_isbn: r.isbn || '', p_publisher: r.publisher || '', p_year: r.pub_year || null, p_edition: r.edition || '' }));
    },
    // ----- 收藏、賣家頁、搜尋紀錄、刪除帳號 -----
    async listFavorites() { return unwrap(await sb.from('favorites').select('book_id,price_at_save,created_at,book:books(*)').order('created_at', { ascending: false }).limit(200)) || []; },
    async addFavorite(bookId) { unwrap(await sb.from('favorites').insert({ book_id: bookId })); },
    async removeFavorite(bookId) { unwrap(await sb.from('favorites').delete().eq('book_id', bookId)); },
    async sellerStats(id) { return unwrap(await sb.rpc('seller_stats', { p_seller: id })); },
    // ----- 通知中心、教材專區、交易爭議 -----
    async listNotifications() { return unwrap(await sb.from('notifications').select('*').order('created_at', { ascending: false }).limit(60)) || []; },
    async unreadNotifCount() { const r = await sb.from('notifications').select('id', { count: 'exact', head: true }).is('read_at', null); return r.count || 0; },
    async markNotificationsRead(ids) { unwrap(await sb.rpc('mark_notifications_read', { p_ids: ids || null })); },
    async getNotifPrefs() { const r = await sb.from('notification_prefs').select('*').maybeSingle(); return Object.assign({ price_drop: true, wish_match: true, trade: true, dispute: true }, r.data || {}); },
    async setNotifPref(kind, on) { unwrap(await sb.rpc('set_notification_pref', { p_kind: kind, p_on: !!on })); },
    async listSemesters() { return unwrap(await sb.from('semesters').select('*').order('start_date', { ascending: false })) || []; },
    async currentSemester() { const r = await sb.rpc('current_semester'); return r.data || null; },
    async listCourses(semId) { return unwrap(await sb.from('courses').select('*, course_textbooks(*)').eq('semester_id', semId).order('dept').order('name')) || []; },
    async reportDispute(tid, reason, detail) { return unwrap(await sb.rpc('report_dispute', { p_thread: tid, p_reason: reason, p_detail: detail || '' })); },
    async listMyDisputes() { return unwrap(await sb.from('transaction_disputes').select('id,thread_id,reason,status,admin_note,created_at').order('created_at', { ascending: false }).limit(100)) || []; },
    logSearch(q, n) { sb.rpc('log_search', { p_q: q, p_found: n }).then(() => {}, () => {}); },
    async deleteMyAccount() {
      const { data: { session } } = await sb.auth.getSession();
      if (session) {   // 先清掉可能還留在雲端的學生證照片
        try { const l = await sb.storage.from('student-cards').list(session.user.id); if (l.data && l.data.length) await sb.storage.from('student-cards').remove(l.data.map((x) => session.user.id + '/' + x.name)); } catch (e) { /* ignore */ }
      }
      unwrap(await sb.rpc('delete_my_account'));
      try { await sb.auth.signOut(); } catch (e) { /* ignore */ }
      try { localStorage.removeItem('cb_login_at'); } catch (e) { /* ignore */ }
    },
    async updateBook(id, r) {
      unwrap(await sb.rpc('update_my_book', {
        p_book: id, p_title: r.title, p_author: r.author, p_course: r.course, p_teacher: r.teacher, p_course_dept: r.course_dept,
        p_price: r.price, p_note: r.note, p_allow_meetup: r.allow_meetup, p_allow_shipping: r.allow_shipping,
        p_meetup_place: r.meetup_place, p_shipping_fee: r.shipping_fee, p_image_url: r.image_url, p_extra_images: r.extra_images || []
      }));
    },
    async listMyBooks(uid) {
      return unwrap(await sb.from('books').select('*').eq('seller_id', uid)
        .in('status', ['active', 'reserved', 'sold']).order('created_at', { ascending: false }));
    },
    async adminSetBookHidden(id, hidden, reason) {
      unwrap(await sb.rpc('admin_set_book_hidden', { p_book: id, p_hidden: !!hidden, p_reason: reason || '' }));
    },
    async setBookStatus(id, status) {
      if (status === 'hidden') unwrap(await sb.from('books').update({ status }).eq('id', id));
      else unwrap(await sb.rpc('set_book_status', { p_book: id, p_status: status }));
    },

    async listWishes() {
      return unwrap(await sb.from('wishes').select(WISH_SELECT)
        .eq('status', 'active').order('created_at', { ascending: false }).limit(500));
    },
    async addWish(row) { unwrap(await sb.from('wishes').insert(row)); },
    async listMyWishes(uid) {
      return unwrap(await sb.from('wishes').select('*').eq('user_id', uid).eq('status', 'active')
        .order('created_at', { ascending: false }));
    },
    async setWishStatus(id, status) { unwrap(await sb.from('wishes').update({ status }).eq('id', id)); },

    async startThread(bookId, method) { return unwrap(await sb.rpc('start_thread', { p_book_id: bookId, p_method: method })); },
    async startWishThread(wishId) { return unwrap(await sb.rpc('start_wish_thread', { p_wish_id: wishId })); },
    async startSupportThread() { return unwrap(await sb.rpc('start_support_thread')); },
    async setThreadStatus(id, status) { unwrap(await sb.rpc('set_thread_status', { p_thread: id, p_status: status })); },
    async listThreads() {
      return unwrap(await sb.from('threads').select(THREAD_SELECT).order('updated_at', { ascending: false }).limit(200));
    },
    async listMessages(tid) {
      return unwrap(await sb.from('messages').select('*').eq('thread_id', tid).order('id', { ascending: true }).limit(500));
    },
    async sendMessage(tid, body, uid) {
      unwrap(await sb.from('messages').insert({ thread_id: tid, sender_id: uid, body }));
    },
    subscribe(tid, cb) {
      const ch = sb.channel('msg-' + tid)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: 'thread_id=eq.' + tid }, cb)
        .subscribe();
      return () => sb.removeChannel(ch);
    },
    // 訂閱「我能看到的所有新訊息」(RLS 會自動過濾,只會收到自己聊聊的訊息),用來即時更新未讀紅點
    subscribeAll(cb) {
      const ch = sb.channel('msg-all')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, cb)
        .subscribe();
      return () => sb.removeChannel(ch);
    }
  };

  // =========================================================
  // 示範模式(資料只存在本機瀏覽器,可測試完整流程)
  // =========================================================
  const KEY = 'demo_db_v2';
  const SELLER = { id: 'demo-seller', display_name: '小明', picture_url: '' };
  const ME = { id: 'demo-me', name: '示範同學', picture: '', banned: false, isAdmin: false, nameSet: true, verified: true, banReason: '' };

  function load() {
    try { const d = JSON.parse(localStorage.getItem(KEY)); if (d) return d; } catch (e) { /* ignore */ }
    const now = new Date().toISOString();
    return {
      books: [
        { id: 'b1', seller_id: SELLER.id, seller: SELLER, title: '微積分(第九版)', author: 'James Stewart', course: '微積分', teacher: '王老師', course_dept: '', price: 350, condition: '九成新', image_url: '', note: '附解答本', allow_meetup: true, allow_shipping: true, meetup_place: '圖書館門口', shipping_fee: 60, status: 'active', created_at: now },
        { id: 'b2', seller_id: SELLER.id, seller: SELLER, title: '經濟學原理', author: 'Mankiw', course: '經濟學', teacher: '', course_dept: '健康事業管理系', price: 280, condition: '有筆記劃線', image_url: '', note: '', allow_meetup: true, allow_shipping: false, meetup_place: '學生餐廳', shipping_fee: 0, status: 'active', created_at: now }
      ],
      wishes: [{ id: 'w1', user_id: SELLER.id, user: SELLER, title: '普通物理學(上)', course: '普通物理', budget: 300, image_url: '', note: '版本不拘', status: 'active', created_at: now }],
      threads: [], messages: []
    };
  }
  const save = (db) => localStorage.setItem(KEY, JSON.stringify(db));
  const uid = () => 'x' + Date.now() + Math.random().toString(36).slice(2, 6);
  const meUser = () => (localStorage.getItem('demo_user') ? Object.assign({}, ME, { department: localStorage.getItem('demo_dept') || '', consented: localStorage.getItem('demo_consent') === window.TERMS.version }) : null);
  const delay = (v) => Promise.resolve(JSON.parse(JSON.stringify(v)));
  const MY_PROFILE = { display_name: ME.name, picture_url: '' };

  function addMsg(db, tid, sender, body, sys) {
    db.messages.push({ id: db.messages.length + 1, thread_id: tid, sender_id: sender, body, is_system: !!sys, created_at: new Date().toISOString() });
    const t = db.threads.find((x) => x.id === tid);
    if (t) t.updated_at = new Date().toISOString();
  }
  const profileOf = (id) => (id === ME.id ? MY_PROFILE : SELLER);
  function hydrate(db, t) {
    const b = db.books.find((x) => x.id === t.book_id);
    const w = db.wishes.find((x) => x.id === t.wish_id);
    return Object.assign({}, t, {
      book: b ? { title: b.title, image_url: b.image_url, price: b.price, status: b.status, meetup_place: b.meetup_place } : null,
      wish: w ? { title: w.title } : null,
      buyer: profileOf(t.buyer_id), seller: profileOf(t.seller_id)
    });
  }

  const demo = {
    async me() { return delay(meUser()); },
    login() { localStorage.setItem('demo_user', '1'); location.reload(); },
    async handleCallback() {},
    async submitStudentCard() { throw new Error('示範模式不需要驗證'); },
    async saveBasicInfo() { throw new Error('示範模式不需要驗證'); },
    async checkBanned() { return { banned: false, reason: '' }; },
    async reportBook() { throw new Error('示範模式不支援檢舉'); },
    async reportThreadUser() { throw new Error('示範模式不支援檢舉'); },
    async rateSeller() { throw new Error('示範模式不支援評價'); },
    async myRatedThreads() { return []; },
    async myRating() { return { avg: null, cnt: 0 }; },
    async listPlaces() { return DEFAULT_PLACES; },
    async createLoginCode() { throw new Error('示範模式不支援登入碼'); },
    async loginWithCode() { throw new Error('示範模式不支援登入碼'); },
    async loginWithPassword() { throw new Error('示範模式不能用 Email 登入'); },
    async updateBookMeta() { /* 示範模式 */ },
    async listFavorites() { return []; },
    async addFavorite() { /* 示範模式 */ },
    async removeFavorite() { /* 示範模式 */ },
    async sellerStats() { return { code: 'DEMO', avg: null, cnt: 0, deals: 0, active: 0, sold: 0, reviews: [] }; },
    async listNotifications() { return []; }, async unreadNotifCount() { return 0; }, async markNotificationsRead() {},
    async getNotifPrefs() { return { price_drop: true, wish_match: true, trade: true, dispute: true }; }, async setNotifPref() {},
    async listSemesters() { return []; }, async currentSemester() { return null; }, async listCourses() { return []; },
    async reportDispute() { return 1; }, async listMyDisputes() { return []; },
    logSearch() { /* 示範模式 */ },
    async deleteMyAccount() { /* 示範模式 */ },
    async setCredentials() { /* 示範模式 */ },
    async setAvatar(v) { ME.picture = v; MY_PROFILE.picture_url = v; },
    async logout() { localStorage.removeItem('demo_user'); },
    async setDepartment(d) { localStorage.setItem('demo_dept', d); },
    async setName(n) { ME.name = n; MY_PROFILE.display_name = n; },
    async signConsent(version) {
      if (version !== window.TERMS.version) throw new Error('同意書版本已更新,請重新整理頁面後再簽署');
      localStorage.setItem('demo_consent', version);
    },
    async listAnnouncements() {
      try { return JSON.parse(localStorage.getItem('demo_ann')) || [{ id: 1, title: '歡迎使用校園二手書', body: '這是示範公告,管理員可在後台發送公告或廣播。', link: '', created_at: new Date().toISOString() }]; }
      catch (e) { return []; }
    },
    async unreadCounts() {
      const db = load();
      const reads = JSON.parse(localStorage.getItem('demo_reads') || '{}');
      const map = {};
      db.threads.filter((t) => t.buyer_id === ME.id || t.seller_id === ME.id).forEach((t) => {
        const n = db.messages.filter((m) => m.thread_id === t.id && m.sender_id !== ME.id && m.id > (reads[t.id] || 0)).length;
        if (n) map[t.id] = n;
      });
      return map;
    },
    async markRead(tid) {
      const db = load();
      const reads = JSON.parse(localStorage.getItem('demo_reads') || '{}');
      reads[tid] = db.messages.filter((m) => m.thread_id === tid).reduce((a, m) => Math.max(a, m.id), 0);
      localStorage.setItem('demo_reads', JSON.stringify(reads));
    },
    async pushState() { return 'unsupported'; },
    async enablePush() {},
    async disablePush() {},
    async syncPush() {},
    async setNotifyEmail() {},
    // 示範模式:存成 data URL(blob 網址關掉分頁後就失效,圖片會消失)
    async uploadImage(file) {
      const blob = await compressImage(file, 800, 0.7);
      return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(new Error('無法讀取圖片'));
        r.readAsDataURL(blob);
      });
    },

    async listBooks() { return delay(load().books.filter((b) => b.status !== 'hidden').reverse()); },
    async addBook(row) {
      const db = load();
      db.books.push(Object.assign({ id: uid(), seller_id: ME.id, seller: MY_PROFILE, status: 'active', created_at: new Date().toISOString() }, row));
      save(db);
    },
    async updateBook(id, r) { const db = load(); Object.assign(db.books.find((b) => b.id === id), r); save(db); },
    async listMyBooks() { return delay(load().books.filter((b) => b.seller_id === ME.id && b.status !== 'hidden')); },
    async setBookStatus(id, status) { const db = load(); db.books.find((b) => b.id === id).status = status; save(db); },
    async adminSetBookHidden(id, hidden) { const db = load(); db.books.find((b) => b.id === id).status = hidden ? 'hidden' : 'active'; save(db); },

    async listWishes() { return delay(load().wishes.filter((w) => w.status === 'active').reverse()); },
    async addWish(row) {
      const db = load();
      db.wishes.push(Object.assign({ id: uid(), user_id: ME.id, user: MY_PROFILE, status: 'active', created_at: new Date().toISOString() }, row));
      save(db);
    },
    async listMyWishes() { return delay(load().wishes.filter((w) => w.user_id === ME.id && w.status === 'active')); },
    async setWishStatus(id, status) { const db = load(); db.wishes.find((w) => w.id === id).status = status; save(db); },

    async startSupportThread() { throw new Error('示範模式不支援聯絡管理員'); },
    async startThread(bookId, method) {
      const db = load();
      const b = db.books.find((x) => x.id === bookId);
      if (!b || b.status !== 'active') throw new Error('此書目前無法購買');
      let t = db.threads.find((x) => x.book_id === bookId && x.buyer_id === ME.id);
      if (!t) {
        t = { id: uid(), book_id: bookId, wish_id: null, buyer_id: ME.id, seller_id: b.seller_id, method, status: 'open', created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
        db.threads.push(t);
        addMsg(db, t.id, ME.id, '買家想購買《' + b.title + '》,選擇「' + (method === 'meetup' ? '面交' : '寄送') + '」交易。', true);
      }
      save(db);
      return t.id;
    },
    async startWishThread(wishId) {
      const db = load();
      const w = db.wishes.find((x) => x.id === wishId);
      let t = db.threads.find((x) => x.wish_id === wishId && x.seller_id === ME.id);
      if (!t) {
        t = { id: uid(), book_id: null, wish_id: wishId, buyer_id: w.user_id, seller_id: ME.id, method: null, status: 'open', created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
        db.threads.push(t);
        addMsg(db, t.id, ME.id, '有同學說他有《' + w.title + '》,可以在這裡討論價格與交易方式。', true);
      }
      save(db);
      return t.id;
    },
    async setThreadStatus(id, status) {
      const db = load();
      const t = db.threads.find((x) => x.id === id);
      if (status === 'accepted' && t.seller_id !== ME.id) throw new Error('只有賣家可以確認交易');
      if (status === 'cancelled') addMsg(db, id, ME.id, '交易已取消。', true);
      t.status = status;
      save(db);
    },
    async listThreads() {
      const db = load();
      return delay(db.threads.filter((t) => t.buyer_id === ME.id || t.seller_id === ME.id)
        .map((t) => hydrate(db, t)).sort((a, b) => b.updated_at.localeCompare(a.updated_at)));
    },
    async listMessages(tid) { return delay(load().messages.filter((m) => m.thread_id === tid)); },
    async sendMessage(tid, body) {
      const db = load();
      addMsg(db, tid, ME.id, body, false);
      save(db);
      // 示範:賣家 1 秒後自動回覆
      setTimeout(() => {
        const d = load();
        addMsg(d, tid, SELLER.id, '收到!我們約個時間吧 😊', false);
        save(d);
      }, 1000);
    },
    subscribe() { return () => {}; },
    subscribeAll() { return () => {}; }
  };

  window.API = Object.assign({ DEMO: DEMO, sb: sb, compressImage: compressImage }, DEMO ? demo : real);
})();
