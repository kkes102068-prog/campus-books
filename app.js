(function () {
  'use strict';

  const API = window.API;
  const STATUS_LABEL = { open: '洽談中', accepted: '已確認', completed: '已完成', cancelled: '已取消' };
  const STATUS_STYLE = { open: 'pill-info', accepted: 'pill-warn', completed: 'pill-ok', cancelled: 'pill-mute' };
  const METHOD_LABEL = { meetup: '🤝 面交', shipping: '📦 寄送' };
  // 書的三種狀態:賣家決定(未售出以外都顯示為灰色)
  const BOOK_ST = { active: '未售出', reserved: '交易中', sold: '已售出' };
  const MEETUP_TAG = '📍【面交約定】';
  const IC = {
    book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>'
  };
  const QUICK = [['all', '全部'], ['meetup', '🤝 可面交'], ['shipping', '📦 可寄送'], ['low', '價格 低→高'], ['high', '價格 高→低']];

  const $ = (id) => document.getElementById(id);
  let me = null;
  let books = [], wishes = [], threads = [];
  let editingBook = null, keepImages = [], mineBooks = [];
  let places = [], deptSel = '', ratedThreads = new Set(), reportTarget = null, rateThread = null, rateStars = 0, pendingBan = null, verifyTimer = null;   // 編輯上架:正在編輯的書、保留的舊照片
  let tab = 'books';
  let quick = 'all';          // 書列表快速篩選 / 排序
  let unread = {};            // thread_id → 未讀數
  const markedUpTo = {};      // thread_id → 已標記已讀的最後訊息 id
  let cur = null;            // 目前開啟的聊聊 id
  let msgs = [];
  let seenMsgs = new Set();   // 已顯示過的訊息 id(只有新訊息才播放動畫,避免整串一直閃)
  let unsub = null, pollTimer = null;
  let buyingId = null;

  // ---------- 工具 ----------
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // 內容沒變就不重畫 DOM(避免定時更新時畫面閃爍、圖片重新載入)
  function setHtml(el, html) {
    if (el.__k === html) return false;
    el.__k = html;
    el.innerHTML = html;
    return true;
  }

  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    if (/^✅/.test(String(msg)) && window.fx) window.fx.confetti();
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.add('hidden'), 3000);
  }

  const show = (id) => $(id).classList.remove('hidden');
  const hide = (id) => $(id).classList.add('hidden');
  const fmtTime = (iso) => {
    const d = new Date(iso);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  };
  const fmtDate = (iso) => { const d = new Date(iso); return (d.getMonth() + 1) + '/' + d.getDate(); };

  function avatar(p, size) {
    const s = size || 28;
    // 匿名:不顯示任何人的頭貼,也不用名字當頭像,一律用統一圖示
    const em = p && typeof p.picture_url === 'string' && p.picture_url.indexOf('e:') === 0 ? p.picture_url.slice(2) : '👤';
    return `<span class="avatar-ph" style="width:${s}px;height:${s}px;font-size:${Math.round(s * 0.5)}px">${esc(em)}</span>`;
  }

  const basicDone = () => !!(me && (me.verified || (me.realName && me.department && me.enrollYear)));
  const profileDone = () => !!(me && basicDone() && me.department && me.nameSet);

  // 註冊流程:登入 → 同意書 → 驗證學校 Email → 設定暱稱與系所
  function openSetup() {
    if (!me) return;
    if (!basicDone()) { openBasic(); return; }
    if (!profileDone()) openProfile(false);
  }

  // 買書、賣書、許願、聊聊:必須先通過學校認證(未認證會導到認證頁)
  function requireVerified() {
    if (!requireLogin()) return false;
    if (!me.verified) {
      toast(me.verifyStatus === 'pending' ? '學校認證審核中,通過後才能買書、賣書與聊聊' : '請先完成學校認證,才能買書、賣書與聊聊');
      openVerify();
      return false;
    }
    if (!me.ownLoginSet && !me.isAdmin && !API.DEMO) { toast('請先設定你的登入帳號(Email 與密碼)'); openCred(); return false; }
    return true;
  }

  // ---------- 認證後:設定自己的登入帳號 ----------
  function openCred() {
    $('form-cred').reset(); hide('cred-error');
    show('modal-cred');
  }
  async function submitCred(e) {
    e.preventDefault();
    const em = $('cred-email').value.trim(), p1 = $('cred-pass').value, p2 = $('cred-pass2').value;
    const err = (m) => { $('cred-error').textContent = m; show('cred-error'); };
    if (p1 !== p2) { err('兩次輸入的密碼不一樣'); return; }
    const btn = $('btn-cred-go'); btn.disabled = true; hide('cred-error');
    try {
      await API.setCredentials(em, p1);
      me = await API.me();
      hide('modal-cred');
      toast('✅ 登入帳號已設定,下次可以用 Email 登入');
      if (tab === 'mine') renderMineVerify();
    } catch (ex) { err(ex.message || '儲存失敗'); }
    finally { btn.disabled = false; }
  }

  function requireLogin() {
    if (!me) { show('modal-login'); return false; }
    if (!me.consented) { openConsent(); return false; }        // 登入後必須先簽署同意書
    if (!profileDone()) { openSetup(); return false; }  // 再填基本資料、設定暱稱(學校認證在需要時才做)
    return true;
  }

  // ---------- 同意書 ----------
  function openConsent() {
    const body = $('consent-body');
    body.innerHTML = window.TERMS.render(false);
    body.scrollTop = 0;
    $('consent-check').checked = false;
    $('consent-check').disabled = true;
    $('btn-consent-submit').disabled = true;
    show('consent-hint');
    hide('consent-error');
    show('modal-consent');
    checkConsentScroll();
  }

  function checkConsentScroll() {
    const b = $('consent-body');
    if (b.scrollHeight - b.scrollTop - b.clientHeight < 40) {
      $('consent-check').disabled = false;
      hide('consent-hint');
    }
  }

  function updateConsentBtn() {
    $('btn-consent-submit').disabled = !$('consent-check').checked;
  }

  async function submitConsent(e) {
    e.preventDefault();
    if (!$('consent-check').checked) return;
    const btn = $('btn-consent-submit');
    btn.disabled = true;
    try {
      await API.signConsent(window.TERMS.version);
      me.consented = true;
      hide('modal-consent');
      toast('✅ 已同意使用條款');
      if (!profileDone()) openSetup(); else render();
    } catch (ex) {
      $('consent-error').textContent = ex.message || '簽署失敗,請稍後再試';
      show('consent-error');
      updateConsentBtn();
    }
  }

  // ---------- 加入主畫面 / 開啟通知 引導 ----------
  const UA = navigator.userAgent;
  const IS_IOS = /iphone|ipad|ipod/i.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const IS_STANDALONE = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  const IN_LINE = /\bLine\//i.test(UA);
  let deferredInstall = null;   // Android / 桌面 Chrome 的安裝提示
  const dismissedRecently = (k) => { try { return Date.now() - Number(localStorage.getItem('dis_' + k) || 0) < 7 * 864e5; } catch (e) { return false; } };
  const markDismissed = (k) => { try { localStorage.setItem('dis_' + k, String(Date.now())); } catch (e) { /* ignore */ } };
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; renderInstallCard(); });

  async function renderInstallCard() {
    const box = $('install-card');
    if (!box) return;
    const card = (key, icon, title, body, acts) => `<div class="install"><div class="ico">${icon}</div><div class="flex-1 min-w-0">
      <h3>${title}</h3>${body}<div class="acts">${acts}<button data-inst="dismiss" data-key="${key}" class="btn btn-ghost btn-sm">我知道了</button></div></div></div>`;
    let html = '';
    if (!IS_STANDALONE && IN_LINE && !dismissedRecently('line')) {
      html = IS_IOS
        ? card('line', '🧭', '請改用 Safari 開啟',
            '<ol><li>點右下角的 <b>「⋯」</b></li><li>選 <b>「在 Safari 中開啟」</b></li><li>在 Safari 再 <b>加入主畫面</b>,才收得到通知</li></ol>',
            '<button data-inst="copy" class="btn btn-primary btn-sm">複製網址</button>')
        : card('line', '🧭', '請改用瀏覽器開啟',
            '<ol><li>點右上角的 <b>「⋮」</b> 或 <b>「⋯」</b></li><li>選 <b>「以其他瀏覽器開啟」</b>(Chrome)</li><li>在瀏覽器裡就能開啟通知、安裝成 App</li></ol>',
            '<button data-inst="copy" class="btn btn-primary btn-sm">複製網址</button>');
    } else if (!IS_STANDALONE && IS_IOS && !dismissedRecently('a2hs')) {
      html = card('a2hs', '📲', '加入主畫面,才能收到通知',
        '<ol><li>點 Safari 下方的 <b>分享</b> 按鈕(方框加向上箭頭)</li><li>往下找 <b>「加入主畫面」</b> 並點下去</li><li>之後都從主畫面的 <b>圖示</b> 開啟本站</li></ol>', '');
    } else if (!IS_STANDALONE && deferredInstall && !dismissedRecently('pwa')) {
      html = card('pwa', '📲', '把北護校園二手書裝到手機', '<p class="text-sm" style="color:var(--muted)">像 App 一樣一鍵開啟,還能收到新訊息通知。</p>',
        '<button data-inst="install" class="btn btn-primary btn-sm">安裝</button>');
    } else if ((IS_STANDALONE || !IS_IOS) && me && me.consented && !dismissedRecently('push')) {   // iPhone 必須先加入主畫面;其他裝置在瀏覽器就能開
      let ps = 'unsupported';
      try { ps = await API.pushState(); } catch (e) { /* ignore */ }
      if (ps === 'off') {
        html = card('push', '🔔', '開啟通知,不錯過訊息', '<p class="text-sm" style="color:var(--muted)">有人傳訊息給你時,手機會跳通知(內容只提示哪本書,不含聊天內容)。</p>',
          '<button data-inst="push" class="btn btn-primary btn-sm">開啟通知</button>');
      }
    }
    box.innerHTML = html;
  }

  // ---------- 公告 ----------
  let anns = [];
  const dismissedAnn = () => { try { return JSON.parse(localStorage.getItem('dismissed_ann') || '[]'); } catch (e) { return []; } };
  const safeLink = (u) => (/^https?:\/\//i.test(u || '') ? u : '');

  function renderAnn() {
    const a = anns.find((x) => dismissedAnn().indexOf(x.id) === -1);
    $('ann-banner').innerHTML = a ? `<div class="ann"><div>
      <div class="flex-1 min-w-0"><div class="font-extrabold">📢 ${esc(a.title)}</div><div class="whitespace-pre-wrap break-words text-sm" style="color:var(--muted)">${esc(a.body)}</div>
      ${safeLink(a.link) ? `<a href="${esc(safeLink(a.link))}" target="_blank" rel="noopener" class="underline font-bold text-sm" style="color:var(--brand-b)">查看詳情</a>` : ''}</div>
      <button data-ann-close="${esc(a.id)}" class="x self-start" style="font-size:24px;width:30px;height:30px;border-radius:50%;color:var(--muted)" aria-label="關閉">&times;</button></div></div>` : '';
  }

  function renderAnnList() {
    const box = $('mine-ann');
    if (!anns.length) { box.innerHTML = ''; return; }
    box.innerHTML = '<h2 class="h-sec">📢 公告</h2><div class="space-y-2.5">' + anns.slice(0, 5).map((a) => `
      <div class="surface p-4 text-sm"><div class="font-extrabold">${esc(a.title)}</div>
        <div class="whitespace-pre-wrap break-words mt-0.5" style="color:var(--muted)">${esc(a.body)}</div>
        <div class="text-[11px] mt-1.5" style="color:var(--muted)">${fmtDate(a.created_at)}${safeLink(a.link) ? ` · <a class="underline" href="${esc(safeLink(a.link))}" target="_blank" rel="noopener">連結</a>` : ''}</div></div>`).join('') + '</div>';
  }

  async function loadAnnouncements() {
    try { anns = await API.listAnnouncements(); } catch (e) { anns = []; }
    renderAnn();
  }

  // ---------- 使用者資料(系所) ----------
  function fillDepartments() {
    const list = window.DEPARTMENTS || [];
    const opts = list.map((d) => `<option>${esc(d)}</option>`).join('');
    $('profile-dept').innerHTML = '<option value="" disabled selected>請選擇系所...</option>' + opts;
    $('sell-dept').innerHTML = '<option value="">選擇開課系所…(或在上方填老師名稱)</option>' + opts;
  }

  function openProfile(closable) {
    $('profile-dept').value = (me && me.department) || '';
    $('profile-name').value = (me && me.nameSet) ? me.name : '';
    $('profile-close').classList.toggle('hidden', !closable);
    $('profile-hint').textContent = closable ? '修改你的暱稱與系所。' : '第一次使用,請先設定暱稱並選擇系所,完成後才能上架、許願與聊聊。';
    hide('profile-error');
    show('modal-profile');
  }

  async function submitProfile(e) {
    e.preventDefault();
    const dept = $('profile-dept').value;
    const nick = $('profile-name').value.trim();
    if (!dept || !nick) return;
    const btn = $('btn-profile-submit');
    btn.disabled = true;
    try {
      if (nick !== me.name || !me.nameSet) { await API.setName(nick); me.name = nick; me.nameSet = true; }
      await API.setDepartment(dept);
      me.department = dept;
      hide('modal-profile');
      toast('✅ 資料已儲存');
      render();
    } catch (ex) {
      $('profile-error').textContent = ex.message || '儲存失敗,請稍後再試';
      show('profile-error');
    } finally { btn.disabled = false; }
  }

  // ---------- 渲染:整體 ----------
  function render() {
    document.querySelectorAll('[data-tab]').forEach((b) => { b.className = 'tab' + (b.dataset.tab === tab ? ' tab-active' : ''); });
    document.querySelectorAll('[data-nav]').forEach((b) => { b.className = 'dock-item' + (b.dataset.nav === tab ? ' dock-active' : ''); });
    $('bottom-nav').classList.toggle('hidden', tab === 'chat' && !!cur);   // 手機:聊天室全螢幕時隱藏導覽列
    const onList = tab === 'books' || tab === 'wishes';
    $('fab').classList.toggle('hidden', !onList);
    $('fab').innerHTML = tab === 'wishes' ? '✨ 許願' : IC.plus + ' 賣書';
    ['books', 'wishes', 'chat', 'mine'].forEach((t) => $('view-' + t).classList.toggle('hidden', t !== tab));
    $('search-wrap').classList.toggle('hidden', !onList);
    $('btn-wish').classList.toggle('hidden', tab !== 'wishes');
    $('hero-title').innerHTML = tab === 'wishes' ? '找不到想要的書?<br class="sm:hidden">許個願吧' : '找到你的<br class="sm:hidden">下一本書';
    $('hero-sub').textContent = tab === 'wishes' ? '有同學剛好有你要的書,就會在站內跟你聊聊。' : '學長姐的二手教科書,面交或寄送,在站內安心聊聊。';
    $('hero-count').textContent = books.filter((b) => b.status === 'active').length;
    $('hero-wish-count').textContent = wishes.length;
    $('search').placeholder = tab === 'wishes' ? '搜尋大家許願的書' : '搜尋書名、課程、老師、系所';
    if (tab === 'books') renderBooks();
    else if (tab === 'wishes') renderWishes();
    else if (tab === 'chat') renderChatView();
    else renderMine();
  }

  function renderHeader() {
    $('btn-login').classList.toggle('hidden', !!me);
    $('btn-me').classList.toggle('hidden', !me);
    $('link-admin').classList.toggle('hidden', !(me && me.isAdmin));
    if (me) {
      $('me-name').textContent = me.name;
      const img = $('me-avatar');
      img.classList.add('hidden');   // 匿名:不顯示頭貼
    }
    const n = me ? Object.keys(unread).reduce((a, k) => a + unread[k], 0) : 0;
    $('chat-badge').textContent = n > 99 ? '99+' : n;
    $('chat-badge').classList.toggle('hidden', n === 0);
    $('nav-badge').textContent = n > 99 ? '99+' : n;
    $('nav-badge').classList.toggle('hidden', n === 0);
    document.title = (n > 0 ? '(' + n + ') ' : '') + '北護校園二手書';
  }

  // ---------- 二手書 ----------
  // ---- 收藏 / 賣家頁 / 交易紀錄 / 提醒 / 刪除帳號 ----
  let favIds = new Set(), favs = [];
  async function loadFavs() {
    if (!me || !me.verified || API.DEMO) { favs = []; favIds = new Set(); return; }
    try { favs = await API.listFavorites(); favIds = new Set(favs.map((f) => String(f.book_id))); } catch (e) { favs = []; favIds = new Set(); }
  }
  const dropCount = () => favs.filter((f) => f.book && f.book.status === 'active' && f.book.price < f.price_at_save).length;
  async function toggleFav(id) {
    if (!requireVerified()) return;
    id = String(id);
    try {
      if (favIds.has(id)) { await API.removeFavorite(id); favIds.delete(id); toast('已取消收藏'); }
      else { await API.addFavorite(id); favIds.add(id); toast('已收藏 ♥ 降價時會提醒你'); }
      document.querySelectorAll('[data-fav="' + id + '"]').forEach((b) => { const on = favIds.has(id); b.classList.toggle('on', on); b.textContent = on ? '♥' : '♡'; });
      loadFavs();
    } catch (ex) { toast(ex.message || '操作失敗'); }
  }
  async function openFavs() {
    if (!requireVerified()) return;
    show('modal-favs');
    $('favs-list').innerHTML = '<p class="hint text-center">載入中…</p>';
    await loadFavs();
    const rows = favs.filter((f) => f.book && f.book.status !== 'hidden');
    $('favs-list').innerHTML = rows.length ? rows.map((f) => {
      const b = f.book, dropped = b.price < f.price_at_save && b.status === 'active';
      return `<div class="row-card flex-wrap"><div class="flex-1 min-w-[8rem]"><div class="font-extrabold truncate">${esc(b.title)}</div>
        <div class="text-xs" style="color:var(--muted)">NT$ ${esc(b.price)} · ${BOOK_ST[b.status] || ''}${dropped ? ` <span class="pill pill-ok">降價了 NT$ ${esc(f.price_at_save)} → ${esc(b.price)}</span>` : ''}</div></div>
        <button data-fav-open="${esc(b.id)}" class="btn btn-ghost btn-sm">查看</button><button data-fav-del="${esc(b.id)}" class="btn btn-ghost btn-sm">取消收藏</button></div>`;
    }).join('') : '<div class="empty !py-8"><p class="text-sm">還沒有收藏的書,在書卡右上角按 ♡ 就會收藏</p></div>';
  }
  async function openSeller(id) {
    if (!requireLogin()) return;
    show('modal-seller');
    $('seller-body').innerHTML = '<p class="hint text-center">載入中…</p>';
    try {
      const s = await API.sellerStats(id);
      const mine = books.filter((b) => b.seller_id === id && (b.status === 'active' || b.status === 'reserved'));
      $('seller-body').innerHTML = `
        <div class="box text-center"><div class="text-sm" style="color:var(--muted)">為保護隱私,只顯示代號</div><div class="font-black text-2xl">賣家 #${esc(s.code)}</div></div>
        <div class="idstats" style="grid-template-columns:repeat(3,1fr)">
          <div><b>${s.avg ? esc(s.avg) + '★' : '—'}</b>${esc(s.cnt)} 筆評價</div><div><b>${esc(s.deals)}</b>完成交易</div><div><b>${esc(s.active)}</b>上架中</div></div>
        <div><h3 class="h-sec">最近的評價</h3>${(s.reviews || []).length ? s.reviews.map((r) => `<div class="row-card"><div class="flex-1"><div>${'★'.repeat(r.stars)}${'☆'.repeat(5 - r.stars)}</div><div class="text-sm">${esc(r.comment || '(沒有留言)')}</div></div><div class="text-xs" style="color:var(--muted)">${esc(String(r.created_at).slice(0, 10))}</div></div>`).join('') : '<p class="hint">還沒有人評價過</p>'}</div>
        <div><h3 class="h-sec">目前上架的書</h3>${mine.length ? mine.map((b) => `<button data-seller-book="${esc(b.id)}" class="mrow" style="width:100%"><span class="mtxt"><b>${esc(b.title)}</b><small>NT$ ${esc(b.price)}${b.condition ? ' · ' + esc(b.condition) : ''}</small></span><span class="mchev">›</span></button>`).join('') : '<p class="hint">目前沒有上架中的書</p>'}</div>`;
    } catch (ex) { $('seller-body').innerHTML = '<p class="err">' + esc(ex.message || '無法取得賣家資料') + '</p>'; }
  }
  async function openTrades(kind) {
    if (!me) return;
    show('modal-trades');
    document.querySelectorAll('#trade-seg [data-trade-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tradeTab === kind));
    try { await loadThreads(); } catch (e) { /* ignore */ }
    const dmap = {}; const DST = { open: '爭議處理中', investigating: '爭議處理中', resolved: '爭議已解決', dismissed: '爭議已結案' };
    try { (await API.listMyDisputes()).forEach((d) => { if (!dmap[d.thread_id]) dmap[d.thread_id] = DST[d.status] || ''; }); } catch (e) { /* ignore */ }
    const mineT = threads.filter((t) => t.book_id && (kind === 'buy' ? t.buyer_id === me.id : t.seller_id === me.id));
    const groups = [['open', '洽談中'], ['accepted', '交易中'], ['completed', '已完成'], ['cancelled', '已取消']];
    const total = mineT.filter((t) => t.status === 'completed').reduce((a, t) => a + (t.book ? Number(t.book.price) || 0 : 0), 0);
    $('trade-body').innerHTML = `<div class="box text-sm">${kind === 'buy' ? '已完成的購買' : '已完成的販售'}:<b>${mineT.filter((t) => t.status === 'completed').length}</b> 筆,合計 <b>NT$ ${total}</b></div>` +
      (mineT.length ? groups.map(([k, label]) => {
        const l = mineT.filter((t) => t.status === k);
        return l.length ? `<div><h3 class="h-sec">${label} <span class="count">${l.length}</span></h3><div class="space-y-2">${l.map((t) => `<button data-trade-open="${esc(t.id)}" class="mrow" style="width:100%"><span class="mtxt"><b>${esc(t.book ? t.book.title : '(這本書已下架)')}</b><small>NT$ ${esc(t.book ? t.book.price : '—')} · ${esc(String(t.updated_at || t.created_at).slice(0, 10))}${dmap[t.id] ? ' · ⚖️ ' + esc(dmap[t.id]) : ''}</small></span><span class="mchev">›</span></button>`).join('')}</div></div>` : '';
      }).join('') : '<div class="empty !py-8"><p class="text-sm">' + (kind === 'buy' ? '還沒有購買紀錄' : '還沒有販售紀錄') + '</p></div>');
  }
  function wishMatchCount(w) {
    const t = String(w.title || '').toLowerCase().replace(/\s+/g, '');
    if (t.length < 2) return 0;
    return books.filter((b) => b.status === 'active' && (!me || b.seller_id !== me.id) && (String(b.title).toLowerCase().replace(/\s+/g, '').indexOf(t) !== -1 || t.indexOf(String(b.title).toLowerCase().replace(/\s+/g, '')) !== -1)).length;
  }
  // 登入後提醒一次:有幾則未讀通知(降價、許願、交易、爭議進度都在通知中心)
  async function notifyMatches() {
    if (!me || !me.verified || API.DEMO) return;
    await loadFavs();
    if (tab === 'books') renderBooks();   // 讓已收藏的書立刻顯示實心愛心
    let flag = '';
    try { flag = sessionStorage.getItem('cb_notified') || ''; } catch (e) { /* ignore */ }
    if (flag) return;
    let n = 0;
    try { n = await API.unreadNotifCount(); } catch (e) { /* ignore */ }
    if (n) { try { sessionStorage.setItem('cb_notified', '1'); } catch (e) { /* ignore */ } toast('🔔 你有 ' + n + ' 則新通知(右上角鈴鐺)'); }
  }
  async function deleteAccount() {
    const t = prompt('刪除帳號會永久刪除你的個人資料、上架的書、許願、收藏與評價,無法復原。\n進行中的交易會被取消。\n確定要刪除的話,請輸入「刪除」兩個字:');
    if (t === null) return;
    if (t.trim() !== '刪除') { toast('輸入不符,已取消'); return; }
    try { await API.deleteMyAccount(); toast('帳號已刪除'); setTimeout(() => location.reload(), 1200); }
    catch (ex) { toast(ex.message || '刪除失敗'); }
  }

  // ---- 最近瀏覽(只存在這支手機,不上傳)----
  function addRecent(id) {
    id = String(id);
    if (id.indexOf('demo-') === 0) return;
    try { const a = JSON.parse(localStorage.getItem('cb_recent') || '[]').filter((x) => x !== id); a.unshift(id); localStorage.setItem('cb_recent', JSON.stringify(a.slice(0, 12))); } catch (e) { /* ignore */ }
    if (typeof renderRecent === 'function') renderRecent();
  }
  function renderRecent() {
    const box = $('recent-box');
    let ids = [];
    try { ids = JSON.parse(localStorage.getItem('cb_recent') || '[]'); } catch (e) { ids = []; }
    const items = ids.map((id) => books.find((b) => String(b.id) === id)).filter(Boolean).slice(0, 8);
    box.classList.toggle('hidden', !items.length);
    box.innerHTML = items.length ? '<div class="recent-head"><b>🕘 最近看過</b><button data-recent-clear class="recent-clear">清除</button></div><div class="recent-row">' +
      items.map((b) => `<button data-recent="${esc(b.id)}" class="recent-chip"><span>${esc(b.title)}</span><small>NT$ ${esc(b.price)}</small></button>`).join('') + '</div>' : '';
  }

  // ---- 通知中心 ----
  const NK = { price_drop: '💰', wish_match: '👀', trade: '🤝', dispute: '⚖️', system: '📢' };
  function ago(t) {
    const m = Math.max(0, Math.round((Date.now() - new Date(t).getTime()) / 60000));
    if (m < 1) return '剛剛'; if (m < 60) return m + ' 分鐘前'; if (m < 1440) return Math.round(m / 60) + ' 小時前'; return Math.round(m / 1440) + ' 天前';
  }
  async function refreshNotifCount() {
    const bell = $('btn-bell');
    if (!me || !me.consented || API.DEMO) { bell.classList.add('hidden'); return; }
    bell.classList.remove('hidden');
    try {
      const n = await API.unreadNotifCount();
      $('bell-badge').textContent = n > 99 ? '99+' : n; $('bell-badge').classList.toggle('hidden', n === 0);
    } catch (e) { /* 還沒執行 v4 SQL 時忽略 */ }
  }
  let notifs = [];
  async function openNotif() {
    show('modal-notif');
    $('notif-list').innerHTML = '<p class="hint text-center">載入中…</p>';
    try { notifs = await API.listNotifications(); } catch (e) { notifs = []; }
    $('notif-list').innerHTML = notifs.length ? notifs.map((n) => `<button data-notif="${esc(n.id)}" class="mrow notif${n.read_at ? '' : ' unread'}" style="width:100%"><span class="mico">${NK[n.kind] || '🔔'}</span><span class="mtxt"><b>${esc(n.title)}</b>${n.body ? `<small>${esc(n.body)}</small>` : ''}<small>${ago(n.created_at)}</small></span>${n.read_at ? '' : '<span class="dot-unread"></span>'}</button>`).join('') : '<div class="empty !py-8"><p class="text-sm">還沒有通知</p></div>';
    try { const p = await API.getNotifPrefs(); document.querySelectorAll('#notif-prefs [data-pref]').forEach((c) => { c.checked = !!p[c.dataset.pref]; }); } catch (e) { /* ignore */ }
  }
  async function clickNotif(id) {
    const n = notifs.find((x) => String(x.id) === String(id));
    if (!n) return;
    if (!n.read_at) { API.markNotificationsRead([n.id]).catch(() => {}); n.read_at = new Date().toISOString(); refreshNotifCount(); }
    const link = n.link || '';
    hide('modal-notif');
    if (link.indexOf('?book=') === 0) { const bk = books.find((x) => String(x.id) === link.slice(6)); if (bk) openPhotos(bk); else toast('這本書已經不在架上了'); }
    else if (link.indexOf('?thread=') === 0) { try { await loadThreads(); } catch (e) { /* ignore */ } if (threads.find((t) => t.id === link.slice(8))) openThread(link.slice(8)); else setTab('chat'); }
    else if (link.indexOf('?tab=') === 0) setTab(link.slice(5));
  }

  // ---- 教材專區 ----
  const zNorm = (s) => String(s || '').toLowerCase().replace(/[\s()()\[\]【】]/g, '');
  const zDigits = (s) => String(s || '').replace(/[^0-9x]/gi, '').toLowerCase();
  function zoneMatches(tb) {
    const t = zNorm(tb.title), i = zDigits(tb.isbn);
    return books.filter((b) => b.status === 'active' && ((i && zDigits(b.isbn) === i) || (t.length >= 2 && zNorm(b.title).length >= 2 && (zNorm(b.title).indexOf(t) !== -1 || t.indexOf(zNorm(b.title)) !== -1))));
  }
  async function openZone() {
    show('modal-zone');
    $('zone-list').innerHTML = '<p class="hint text-center">載入中…</p>';
    try {
      const sems = await API.listSemesters();
      if (!sems.length) { $('zone-sem').innerHTML = ''; $('zone-list').innerHTML = '<div class="empty !py-8"><p class="text-sm">管理員還沒有建立課程教材資料,敬請期待</p></div>'; return; }
      const cur = await API.currentSemester();
      $('zone-sem').innerHTML = sems.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}${x.id === cur ? '(本學期)' : ''}</option>`).join('');
      $('zone-sem').value = String(cur || sems[0].id);
      const depts = window.DEPARTMENTS || [];
      $('zone-dept').innerHTML = '<option value="">全部系所</option>' + depts.map((d) => `<option>${esc(d)}</option>`).join('');
      await renderZone();
    } catch (e) { $('zone-list').innerHTML = '<p class="err">' + esc(e.message || '載入失敗') + '</p>'; }
  }
  async function renderZone() {
    const sem = $('zone-sem').value, dept = $('zone-dept').value;
    if (!sem) return;
    let courses = await API.listCourses(sem);
    if (dept) courses = courses.filter((c) => c.dept === dept);
    $('zone-list').innerHTML = courses.length ? courses.map((c) => {
      const tbs = (c.course_textbooks || []).map((t) => ({ t, n: zoneMatches(t).length })).sort((a, b2) => b2.n - a.n);
      return `<div class="zone-course"><div class="zone-ct"><b>${esc(c.name)}</b><small>${esc(c.dept)}${c.teacher ? ' · ' + esc(c.teacher) : ''}</small></div>` +
        (tbs.length ? tbs.map(({ t, n }) => `<div class="zone-tb"><div class="zone-tt"><b>${esc(t.title)}</b> <span class="pill ${t.required ? 'pill-warn' : 'pill-mute'}">${t.required ? '必備' : '參考'}</span>${t.isbn ? `<small>ISBN ${esc(t.isbn)}</small>` : ''}${t.note ? `<small>${esc(t.note)}</small>` : ''}</div>
          ${n ? `<button data-zone-find="${esc(t.title)}" class="btn btn-primary btn-sm">有 ${n} 本在賣 ›</button>` : `<button data-zone-wish="${esc(t.title)}" class="btn btn-ghost btn-sm">沒人賣 · 去許願</button>`}</div>`).join('') : '<p class="hint">這門課還沒有指定教材</p>') + '</div>';
    }).join('') : '<div class="empty !py-8"><p class="text-sm">這個學期、系所還沒有課程教材資料</p></div>';
  }

  // ---- 交易爭議 ----
  let disputeThread = null;
  function openDispute(tid) { if (!requireVerified()) return; disputeThread = tid; $('form-dispute').reset(); hide('dispute-error'); show('modal-dispute'); }
  async function submitDispute(e) {
    e.preventDefault();
    const f = e.target.elements;
    try { await API.reportDispute(disputeThread, f.reason.value, f.detail.value.trim()); hide('modal-dispute'); toast('✅ 已送出爭議,管理員處理後會通知你'); }
    catch (ex) { $('dispute-error').textContent = ex.message || '送出失敗'; show('dispute-error'); }
  }

  // ---- 管理員示範書:只存在這個人的畫面,不寫進資料庫;3 分鐘後自動消失 ----
  let demoBooks = [], demoTimer = 0, demoEnds = 0;
  const DEMO_TITLES = ['基礎護理學', '內外科護理學', '解剖學', '生理學', '藥理學', '病理學', '微生物免疫學', '生物化學', '營養學', '社區衛生護理學', '精神科護理學', '兒科護理學', '婦產科護理學', '老人護理學', '健康評估', '流行病學', '醫學統計', '公共衛生學', '物理治療導論', '復健醫學', '長期照護概論', '運動生理學', '人體解剖圖譜', '英文(一)', '大學國文', '心理學', '社會學', '倫理學', '管理學', '資訊素養'];
  function demoStop() {
    clearInterval(demoTimer); demoTimer = 0; demoBooks = [];
    const b = $('btn-demo-books'); if (b) b.textContent = '🧪 加入示範書';
    if (tab === 'books') renderBooks();
  }
  function demoStart() {
    const depts = (window.DEPARTMENTS || ['護理系']).map((d) => (typeof d === 'string' ? d : d.name || d.label || String(d)));
    const st = ['active', 'active', 'active', 'active', 'reserved', 'sold'];
    demoBooks = DEMO_TITLES.map((t, i) => ({
      id: 'demo-' + i, title: t, price: 80 + ((i * 37) % 420), status: st[i % st.length], seller_id: 'demo', course: t, teacher: '示範老師',
      course_dept: depts[i % depts.length], allow_meetup: true, allow_shipping: i % 2 === 0, image_url: '', extra_images: [],
      created_at: new Date(Date.now() - i * 60000).toISOString(), rating: null, _demo: true
    }));
    demoEnds = Date.now() + 180000;
    clearInterval(demoTimer);
    demoTimer = setInterval(() => {
      const left = Math.ceil((demoEnds - Date.now()) / 1000);
      if (left <= 0) { demoStop(); toast('示範書已自動移除'); return; }
      $('btn-demo-books').textContent = '🧪 示範書剩 ' + Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0') + '(點一下移除)';
    }, 500);
    if (tab === 'books') renderBooks();
  }

  function filteredBooks() {
    const rankD = { active: 0, reserved: 1, sold: 2 };
    const src = demoBooks.length ? demoBooks.concat(books).sort((a, c) => (rankD[a.status] - rankD[c.status]) || (new Date(c.created_at) - new Date(a.created_at))) : books;
    const kws = $('search').value.toLowerCase().split(/\s+/).filter(Boolean);
    const pmin = parseInt($('adv-min').value, 10), pmax = parseInt($('adv-max').value, 10), cnd = $('adv-cond').value;
    let list = src.filter((b) => {
      const hay = (b.title + ' ' + (b.course || '') + ' ' + (b.author || '') + ' ' + (b.teacher || '') + ' ' + (b.course_dept || '') + ' ' + (b.publisher || '') + ' ' + (b.isbn || '') + ' ' + String(b.isbn || '').replace(/[^0-9x]/gi, '')).toLowerCase();
      if (!kws.every((k) => hay.indexOf(k) !== -1)) return false;
      if (deptSel && b.course_dept !== deptSel) return false;
      if (!isNaN(pmin) && b.price < pmin) return false;
      if (!isNaN(pmax) && b.price > pmax) return false;
      if (cnd && b.condition !== cnd) return false;
      if (quick === 'meetup') return !!b.allow_meetup;
      if (quick === 'shipping') return !!b.allow_shipping;
      return true;
    });
    if (quick === 'low' || quick === 'high') {
      const rank = { active: 0, reserved: 1, sold: 2 };   // 仍維持 未售出 → 交易中 → 已售出,只在區內依價格排序
      list = list.slice().sort((a, c) => (rank[a.status] - rank[c.status]) || (quick === 'low' ? a.price - c.price : c.price - a.price));
    }
    return list;
  }

  function buyButton(b) {
    if (me && b.seller_id === me.id) return '<span class="tag" style="align-self:flex-start">我的書</span>';
    if (b.status !== 'active') return `<span class="btn btn-ghost btn-sm btn-block" style="pointer-events:none">${BOOK_ST[b.status]}</span>`;
    return `<button data-buy="${esc(b.id)}" class="btn btn-primary btn-sm btn-block">我想買</button>`;
  }

  // 同一畫面依狀態分區,每區開頭顯示標題
  function sectionHeader(list, i) {
    const st = list[i].status;
    if (i > 0 && list[i - 1].status === st) return '';
    const n = list.filter((x) => x.status === st).length;
    const color = { active: 'var(--ok)', reserved: 'var(--warn)', sold: 'var(--muted)' }[st];
    return `<h2 class="sec"><span class="dot" style="background:${color}"></span><span>${BOOK_ST[st]}</span><span class="count">${n}</span><span class="line"></span></h2>`;
  }

  // 書太多時:一次只顯示一部分(按「顯示更多」再載入),已售出的預設收起來
  const BOOK_PAGE = 20;   // 每頁 20 本,超過就分頁
  let bookPage = 1, showSold = false, lastFilterKey = '';

  function renderPager(pages) {
    const el = $('pager');
    el.classList.toggle('hidden', pages <= 1);
    if (pages <= 1) { el.innerHTML = ''; return; }
    const nums = [];
    for (let p = 1; p <= pages; p++) if (p === 1 || p === pages || Math.abs(p - bookPage) <= 1) nums.push(p);
    let html = `<button data-page="${bookPage - 1}" class="pg" ${bookPage === 1 ? 'disabled' : ''}>‹ 上一頁</button>`;
    let last = 0;
    nums.forEach((p) => { if (p - last > 1) html += '<span class="pg-gap">…</span>'; html += `<button data-page="${p}" class="pg${p === bookPage ? ' pg-on' : ''}">${p}</button>`; last = p; });
    html += `<button data-page="${bookPage + 1}" class="pg" ${bookPage === pages ? 'disabled' : ''}>下一頁 ›</button>`;
    el.innerHTML = html + `<span class="pg-info">第 ${bookPage} / ${pages} 頁</span>`;
  }

  function renderBooks() {
    const all = filteredBooks();
    $('btn-demo-books').classList.toggle('hidden', !(me && me.isAdmin));
    renderRecent();
    const key = $('search').value + '|' + deptSel + '|' + quick + '|' + $('adv-min').value + '|' + $('adv-max').value + '|' + $('adv-cond').value;
    if (key !== lastFilterKey) { lastFilterKey = key; bookPage = 1; showSold = false; }
    const soldN = all.filter((b) => b.status === 'sold').length;
    const open = all.filter((b) => b.status !== 'sold');
    const pool = showSold ? all : open;
    const pages = Math.max(1, Math.ceil(pool.length / BOOK_PAGE));
    if (bookPage > pages) bookPage = pages;
    const list = pool.slice((bookPage - 1) * BOOK_PAGE, bookPage * BOOK_PAGE);
    renderPager(pages);
    $('btn-sold').classList.toggle('hidden', soldN === 0 || bookPage < pages);
    $('btn-sold').textContent = showSold ? '收起已售出的書' : '看已售出的 ' + soldN + ' 本';
    $('chips').innerHTML = QUICK.map((q) => `<button data-quick="${q[0]}" class="chip${quick === q[0] ? ' chip-active' : ''}">${q[1]}</button>`).join('');
    $('count-books').textContent = '共 ' + open.length + ' 本在架上' + (soldN ? '(另有 ' + soldN + ' 本已售出)' : '');
    $('empty').classList.toggle('hidden', all.length > 0);
    $('grid').innerHTML = list.map((b, i) => sectionHeader(list, i) + `
      <article class="book${b.status !== 'active' ? ' off' : ''}" data-detail="${esc(b.id)}" style="--i:${i}; cursor:pointer">
        <div class="book-media">
          <span class="st st-${esc(b.status)}">${BOOK_ST[b.status] || ''}</span>
          ${b.image_url ? `<img src="${esc(b.image_url)}" alt="${esc(b.title)}" loading="lazy"${(b.extra_images || []).length ? `` : ''}>` : `<div class="ph">${IC.book}</div>`}
          ${(b.extra_images || []).length ? `<span class="tag" style="position:absolute;left:8px;bottom:8px;background:rgba(0,0,0,.55);color:#fff">📷 ${1 + b.extra_images.length}</span>` : ''}
          ${me && me.id === b.seller_id ? '' : `<button class="fav${favIds.has(String(b.id)) ? ' on' : ''}" data-fav="${esc(b.id)}" aria-label="收藏">${favIds.has(String(b.id)) ? '♥' : '♡'}</button>`}
          <span class="price-tag">NT$ ${esc(b.price)}</span>
        </div>
        <div class="book-body">
          <h3 class="book-title">${esc(b.title)}</h3>
          ${b.course ? `<p class="meta">📘 ${esc(b.course)}</p>` : ''}
          ${b.teacher ? `<p class="meta">🎓 ${esc(b.teacher)}</p>` : ''}
          ${b.course_dept ? `<p class="meta">🏫 ${esc(b.course_dept)}</p>` : ''}
          ${b.rating ? `<p class="meta">⭐ ${b.rating.avg.toFixed(1)}(${b.rating.cnt} 筆評價)</p>` : '<p class="meta" style="opacity:.55">賣家尚無評價</p>'}
          <div class="tags">
            ${b.allow_meetup ? '<span class="tag">🤝 面交</span>' : ''}
            ${b.allow_shipping ? '<span class="tag">📦 寄送</span>' : ''}
          </div>
          <div class="book-cta">
            ${buyButton(b)}
            ${me && me.isAdmin ? `<button data-admin-hide="${esc(b.id)}" class="admin-hide">🛡 管理員下架</button>` : ''}
          </div>
        </div>
      </article>`).join('');
  }

  // ---------- 許願池 ----------
  function renderWishes() {
    const kws = $('search').value.toLowerCase().split(/\s+/).filter(Boolean);
    const list = wishes.filter((w) => {
      const hay = (w.title + ' ' + (w.course || '')).toLowerCase();
      return kws.every((k) => hay.indexOf(k) !== -1);
    });
    $('count-wishes').textContent = '共 ' + list.length + ' 個願望';
    $('wish-empty').classList.toggle('hidden', list.length > 0);
    $('wish-grid').innerHTML = list.map((w, i) => `
      <article class="wish" style="--i:${i}">
        <div class="wish-top"></div>
        ${w.image_url ? `<img src="${esc(w.image_url)}" alt="${esc(w.title)}" loading="lazy">` : ''}
        <div class="wish-body">
          <div class="flex items-start justify-between gap-2">
            <h3 class="font-extrabold leading-snug">✨ ${esc(w.title)}</h3>
            ${w.budget != null ? `<span class="pill pill-warn shrink-0">預算 NT$ ${esc(w.budget)}</span>` : ''}
          </div>
          ${w.course ? `<p class="meta">📘 ${esc(w.course)}</p>` : ''}
          ${w.note ? `<p class="text-sm" style="color:var(--muted)">${esc(w.note)}</p>` : ''}
          ${me && w.user_id === me.id
            ? '<span class="tag mt-auto" style="align-self:flex-start">我的願望</span>'
            : `<button data-wish-help="${esc(w.id)}" class="btn btn-ok btn-sm mt-auto" style="align-self:flex-end">我有這本書</button>`}
        </div>
      </article>`).join('');
  }

  // ---------- 聊聊 ----------
  async function loadThreads() {
    if (!me) { threads = []; return; }
    try { threads = await API.listThreads(); } catch (e) { console.error(e); }
    try { ratedThreads = new Set(await API.myRatedThreads(me.id)); } catch (e) { ratedThreads = new Set(); }
    renderHeader();
  }

  const otherOf = (t) => (t.buyer_id === me.id ? t.seller : t.buyer);
  const titleOf = (t) => (t.kind === 'support'
    ? (t.seller_id === me.id ? '💬 客服:' + ((t.buyer && t.buyer.display_name) || '使用者') : '💬 管理員客服')
    : t.book ? t.book.title : '🙏 ' + (t.wish ? t.wish.title : '願望'));

  function renderChatView() {
    $('chat-panel').classList.toggle('hidden', !cur);
    $('thread-list').classList.toggle('hidden', !!cur);
    $('support-bar').classList.toggle('hidden', !!cur || !me || me.isAdmin || API.DEMO);
    $('thread-empty').classList.toggle('hidden', !!cur || threads.length > 0);
    if (cur) { renderChat(); return; }
    setHtml($('thread-list'), threads.map((t, i) => {
      const o = otherOf(t);
      const role = t.kind === 'support' ? '客服' : t.buyer_id === me.id ? '我是買家' : '我是賣家';
      return `
      <button data-thread="${esc(t.id)}" class="thread" style="--i:${i}">
        ${avatar(o, 46)}
        <div class="flex-1 min-w-0">
          <div class="font-extrabold truncate">${esc(titleOf(t))}</div>
          <div class="text-xs truncate" style="color:var(--muted)">${esc(o && o.display_name)} · ${role}${t.method ? ' · ' + METHOD_LABEL[t.method] : ''}</div>
        </div>
        <div class="text-right shrink-0">
          ${unread[t.id] ? `<span class="badge mr-1">${unread[t.id]}</span>` : ''}<span class="pill ${STATUS_STYLE[t.status]}">${STATUS_LABEL[t.status]}</span>
          <div class="text-[11px] mt-1" style="color:var(--muted)">${fmtDate(t.updated_at)}</div>
        </div>
      </button>`;
    }).join(''));
  }

  function renderChat() {
    const t = threads.find((x) => x.id === cur);
    if (!t) return;
    const o = otherOf(t);
    const iAmSeller = t.seller_id === me.id;
    $('chat-title').textContent = titleOf(t);
    $('chat-sub').textContent = (t.kind === 'support' ? (iAmSeller ? '使用者:' : '管理員:') : '與 ') + ((o && o.display_name) || '') + (t.kind === 'support' ? '' : ' 聊聊') +
      (t.method ? ' · ' + METHOD_LABEL[t.method] : '') +
      (t.book ? ' · NT$ ' + t.book.price : '');
    const st = $('chat-status');
    st.textContent = STATUS_LABEL[t.status];
    st.className = 'pill ' + STATUS_STYLE[t.status];

    renderChatBook(t, iAmSeller);

    const acts = [];
    const isSupport = t.kind === 'support';
    if (!isSupport && iAmSeller && t.status === 'open') acts.push(['accepted', '✅ 確認交易', 'btn-ok']);
    if (!isSupport && iAmSeller && t.status === 'accepted') acts.push(['completed', '🎉 完成交易', 'btn-ok']);
    if (!isSupport && (t.status === 'open' || t.status === 'accepted')) acts.push(['cancelled', '取消交易', 'btn-ghost']);
    if (!isSupport && t.method !== 'shipping' && (t.status === 'open' || t.status === 'accepted')) {
      acts.unshift(['meetup', '📍 約定面交', 'btn-primary']);
    }
    if (!isSupport && t.status === 'completed' && t.buyer_id === me.id && !ratedThreads.has(t.id)) acts.unshift(['rate', '⭐ 給賣家評價', 'btn-primary']);
    if (!isSupport) acts.push(['dispute', '⚖️ 交易爭議', 'btn-ghost']);
    if (!isSupport) acts.push(['report', '🚩 檢舉對方', 'btn-ghost']);
    const box = $('chat-actions');
    box.classList.toggle('hidden', acts.length === 0);
    setHtml(box, acts.map((a) => `<button data-act="${a[0]}" class="btn btn-sm ${a[2]}">${a[1]}</button>`).join(''));

    const input = $('chat-input');
    input.disabled = t.status === 'cancelled';
    input.placeholder = t.status === 'cancelled' ? '交易已取消' : '輸入訊息…';

    const el = $('chat-msgs');
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    const one = (m, flagNew) => {
      const fresh = flagNew && !seenMsgs.has(m.id) ? ' bubble-new' : '';
      if (m.is_system) return `<div class="sys${fresh}"><span>${esc(m.body)}</span></div>`;
      const mine = m.sender_id === me.id;
      const side = mine ? 'items-end' : 'items-start';
      if (m.body.indexOf(MEETUP_TAG) === 0) {
        return `<div class="flex flex-col ${side}${fresh}" style="max-width:88%;align-self:${mine ? 'flex-end' : 'flex-start'}"><div class="meetup-card">${esc(m.body)}</div>
          <div class="text-[10px] mt-1" style="color:var(--muted)">${mine ? '我' : esc(o && o.display_name)} · ${fmtTime(m.created_at)}</div></div>`;
      }
      return `<div class="flex flex-col ${side}${fresh}" style="max-width:80%;align-self:${mine ? 'flex-end' : 'flex-start'}">
        <div class="bubble ${mine ? 'bubble-me' : 'bubble-them'}">${esc(m.body)}</div>
        <div class="text-[10px] mt-1" style="color:var(--muted)">${fmtTime(m.created_at)}</div></div>`;
    };
    const plain = msgs.map((m) => one(m, false)).join('');
    if (el.__k !== plain) {                       // 沒有新內容就完全不動 DOM,畫面不會閃
      if (!renderChat._first && el.__k && plain.indexOf(el.__k) === 0) {
        // 只是多了新訊息:把新的加到最後面,舊的完全不動
        el.insertAdjacentHTML('beforeend', msgs.filter((m) => !seenMsgs.has(m.id)).map((m) => one(m, true)).join(''));
      } else {
        el.innerHTML = plain;
      }
      el.__k = plain;
      msgs.forEach((m) => seenMsgs.add(m.id));
      if (nearBottom || renderChat._first) el.scrollTop = el.scrollHeight;
    }
    renderChat._first = false;
  }

  // 任何一則新訊息(即時推送)→ 稍等 300ms 合併處理,更新紅點與目前開啟的聊天室
  let anyMsgTimer = null;
  function onAnyMessage() {
    clearTimeout(anyMsgTimer);
    anyMsgTimer = setTimeout(() => { refreshUnread(); if (cur) refreshChat(); }, 300);
  }

  async function refreshUnread() {
    if (!me) { unread = {}; renderHeader(); return; }
    try { unread = await API.unreadCounts(); } catch (e) { console.error(e); }
    // 有新的聊聊(或在列表畫面)時重新載入聊聊清單
    if ((tab === 'chat' && !cur) || Object.keys(unread).some((id) => !threads.find((t) => t.id === id))) await loadThreads();
    renderHeader();
    if (tab === 'chat' && !cur) renderChatView();
  }

  // 正在看這串聊聊時,把它標為已讀
  async function markCurRead() {
    if (!cur || tab !== 'chat' || document.hidden) return;
    const lastId = msgs.length ? msgs[msgs.length - 1].id : 0;
    if (markedUpTo[cur] === lastId) return;
    markedUpTo[cur] = lastId;
    try { await API.markRead(cur); } catch (e) { console.error(e); return; }
    delete unread[cur];
    renderHeader();
  }

  async function refreshChat() {
    if (!cur) return;
    try {
      const [m, t] = await Promise.all([API.listMessages(cur), API.listThreads()]);
      msgs = m; threads = t;
      renderHeader();
      if (tab === 'chat' && cur) { renderChat(); markCurRead(); }
    } catch (e) { console.error(e); }
  }

  async function openThread(id) {
    cur = id; msgs = []; renderChat._first = true; seenMsgs = new Set();
    $('chat-msgs').__k = null;
    if (unsub) unsub();
    unsub = API.subscribe(id, refreshChat);
    clearInterval(pollTimer);
    pollTimer = setInterval(refreshChat, 4000);
    tab = 'chat';
    await loadThreads();
    msgs = await API.listMessages(id);
    render();
    markCurRead();
  }

  function closeThread() {
    cur = null;
    if (unsub) { unsub(); unsub = null; }
    clearInterval(pollTimer);
    loadThreads().then(() => { render(); refreshUnread(); });
  }

  async function sendChat(e) {
    e.preventDefault();
    const input = $('chat-input');
    const body = input.value.trim();
    if (!body || !cur) return;
    input.value = '';
    try {
      await API.sendMessage(cur, body, me.id);
      await refreshChat();
      setTimeout(refreshChat, 1400);
    } catch (ex) { toast('傳送失敗:' + (ex.message || '請稍後再試')); input.value = body; }
  }

  async function threadAction(status) {
    const msg = { accepted: '確認這筆交易?書會顯示為「交易中」。', completed: '確認交易已完成?書會標記為已售出。', cancelled: '確定取消這筆交易?' }[status];
    if (!confirm(msg)) return;
    try { await API.setThreadStatus(cur, status); await refreshChat(); }
    catch (ex) { toast(ex.message || '操作失敗'); }
  }

  function renderChatBook(t, iAmSeller) {
    const box = $('chat-book');
    const b = t.book;
    if (!b && !t.wish) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const thumb = b && b.image_url
      ? `<img src="${esc(b.image_url)}" alt="" class="object-cover shrink-0" style="width:54px;height:54px;border-radius:16px">`
      : `<span class="shrink-0 grid place-items-center text-2xl" style="width:54px;height:54px;border-radius:16px;background:var(--surface)">${b ? '📖' : '🙏'}</span>`;
    let right = '';
    if (b && iAmSeller && t.book_id) {
      right = '<div class="flex flex-col gap-1 items-end shrink-0"><span class="text-[10px]" style="color:var(--muted)">書的狀態(賣家設定)</span><div class="seg">' +
        ['active', 'reserved', 'sold'].map((k) =>
          `<button data-bookst="${k}" class="${b.status === k ? 'on' : ''}">${BOOK_ST[k]}</button>`).join('') + '</div></div>';
    } else if (b) {
      right = `<span class="pill shrink-0 ${b.status === 'active' ? 'pill-ok' : 'pill-mute'}">${BOOK_ST[b.status] || ''}</span>`;
    }
    setHtml(box, `${thumb}<div class="flex-1 min-w-0">
      <div class="text-[11px]" style="color:var(--muted)">${b ? '正在聊這本書' : '正在聊這個願望'}</div>
      <div class="font-extrabold text-sm truncate">${esc(b ? b.title : t.wish.title)}</div>
      ${b ? `<div class="text-sm font-black" style="color:var(--brand-b)">NT$ ${esc(b.price)}</div>` : ''}</div>${right}`);
  }

  async function setBookFromChat(status) {
    const t = threads.find((x) => x.id === cur);
    if (!t || !t.book_id) return;
    try {
      await API.setBookStatus(t.book_id, status);
      await loadBooks();
      await refreshChat();
      toast('已改為「' + BOOK_ST[status] + '」');
    } catch (ex) { toast(ex.message || '操作失敗'); }
  }

  function openMeetup() {
    const t = threads.find((x) => x.id === cur);
    const f = $('form-meetup').elements;
    f.place.value = (t && t.book && t.book.meetup_place) || '';
    show('modal-meetup');
  }

  async function submitMeetup(e) {
    e.preventDefault();
    const f = e.target.elements;
    const d = new Date(f.time.value);
    const wk = '日一二三四五六'[d.getDay()];
    const when = (d.getMonth() + 1) + '/' + d.getDate() + '(' + wk + ') ' +
      String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    const body = MEETUP_TAG + '\n地點:' + f.place.value.trim() + '\n時間:' + when +
      (f.note.value.trim() ? '\n備註:' + f.note.value.trim() : '');
    try {
      await API.sendMessage(cur, body, me.id);
      e.target.reset();
      hide('modal-meetup');
      await refreshChat();
      setTimeout(refreshChat, 1400);
    } catch (ex) { toast('傳送失敗:' + (ex.message || '請稍後再試')); }
  }

  // 重新整理:重新抓書、願望、公告、聊聊與未讀(不用整頁重載;iPhone 主畫面 App 沒有瀏覽器的重新整理鈕)
  let refreshing = false;
  async function refreshAll() {
    if (refreshing) return;
    refreshing = true;
    document.querySelectorAll('[data-refresh]').forEach((b) => b.classList.add('spin'));
    try {
      await Promise.all([loadBooks(), API.listWishes().then((w) => { wishes = w; }), loadAnnouncements(), loadThreads()]);
      if (me) await refreshUnread();
      if (cur) await refreshChat();
      render();
      toast('已更新 ✨');
    } catch (e) {
      console.error(e);
      toast('更新失敗,請稍後再試');
    } finally {
      refreshing = false;
      document.querySelectorAll('[data-refresh]').forEach((b) => b.classList.remove('spin'));
    }
  }

  async function loadBooks() {
    const rank = { active: 0, reserved: 1, sold: 2 };
    const list = await API.listBooks();
    // 未售出 → 交易中 → 已售出;同一狀態內依上架時間,新的在前
    books = list.slice().sort((a, c) => (rank[a.status] - rank[c.status]) || (new Date(c.created_at) - new Date(a.created_at)));
  }

  // ---------- 我的 ----------
  async function renderMine() {
    if (!me) return;
    renderMineVerify();
    API.myRating().then((r) => { const el = $('st-rating'); if (el) el.textContent = r && r.cnt ? r.avg.toFixed(1) + '★' : '—'; }).catch(() => {});
    let myBooks = [], myWishes = [];
    try { [myBooks, myWishes] = await Promise.all([API.listMyBooks(me.id), API.listMyWishes(me.id)]); } catch (e) { console.error(e); }
    mineBooks = myBooks;
    if ($('st-books')) $('st-books').textContent = myBooks.filter((b) => b.status === 'active' || b.status === 'reserved').length;
    if ($('st-wishes')) $('st-wishes').textContent = myWishes.filter((w) => w.status === 'active').length;
    $('mine-books').innerHTML = myBooks.length ? myBooks.map((b) => `
      <div class="row-card flex-wrap">
        <div class="flex-1 min-w-[8rem]"><div class="font-extrabold truncate">${esc(b.title)}</div>
          <div class="text-xs" style="color:var(--muted)">NT$ ${esc(b.price)} · ${BOOK_ST[b.status] || b.status}</div></div>
        <div class="seg">
          ${['active', 'reserved', 'sold'].map((k) => `<button data-book-status="${k}" data-id="${esc(b.id)}" class="${b.status === k ? 'on' : ''}">${BOOK_ST[k]}</button>`).join('')}
        </div>
        ${b.status === 'sold' ? '' : `<button data-book-edit="${esc(b.id)}" class="btn btn-ghost btn-sm">編輯</button>`}
        <button data-book-status="hidden" data-id="${esc(b.id)}" class="btn btn-ghost btn-sm">下架</button>
      </div>`).join('') : '<div class="empty !py-8"><p class="text-sm">還沒有上架的書,按「賣書」開始吧</p></div>';
    $('mine-wishes').innerHTML = myWishes.length ? myWishes.map((w) => `
      <div class="row-card flex-wrap">
        <div class="flex-1 min-w-[8rem]"><div class="font-extrabold truncate">✨ ${esc(w.title)}</div>${wishMatchCount(w) ? `<div class="text-xs" style="color:var(--ok)">👀 目前有 ${wishMatchCount(w)} 本符合的書,去逛逛</div>` : ''}</div>
        <button data-wish-status="fulfilled" data-id="${esc(w.id)}" class="btn btn-ok btn-sm">已找到</button>
        <button data-wish-status="hidden" data-id="${esc(w.id)}" class="btn btn-ghost btn-sm">取消許願</button>
      </div>`).join('') : '<div class="empty !py-8"><p class="text-sm">還沒有許願</p></div>';
    renderNotify();
    renderAnnList();
  }

  function renderMineVerify() {
    if (!me || !$('mine-profile')) return;
    const st = me.verified ? 'ok' : (me.verifyStatus === 'pending' ? 'pending' : (me.verifyStatus === 'rejected' ? 'rejected' : 'none'));
    const tag = { ok: '已認證', pending: '審核中', rejected: '被退回', none: '未認證' }[st];
    const badge = { ok: ['已驗證', 'mb-ok'], pending: ['審核中', 'mb-wait'], rejected: ['被退回', 'mb-bad'], none: ['未驗證', 'mb-bad'] }[st];
    const sub = { ok: '你可以買書、賣書、許願與聊聊', pending: '管理員審核中,最長約 24 小時', rejected: '申請被退回' + (me.verifyNote ? ':' + me.verifyNote : '') + ',請重新送出', none: '尚未認證,無法買書、賣書、許願與聊聊' }[st];
    $('mine-profile').innerHTML = `<div class="idcard">
        <div class="idcard-top"><span class="idcard-tag idtag-${st}">${tag}</span><span class="idcard-brand">北護校園二手書</span></div>
        <div class="idcard-school"><img src="school-logo.png" alt="國立臺北護理健康大學" height="26"></div>
        <div class="idcard-main">
          <div class="idphoto">${avatar({ display_name: me.name, picture_url: me.picture }, 76)}<button id="btn-edit-avatar" class="idcam" aria-label="更換頭像">📷</button></div>
          <div class="idinfo">
            <div class="idlabel">姓名</div>
            <div class="idname">${esc(me.realName || me.name)}${me.isAdmin ? ' 👑' : ''}</div>
            <div class="idrow"><span>暱稱</span>${esc(me.name)}</div>
            <div class="idrow"><span>科系</span>${esc(me.department || '尚未填寫')}</div>
            <div class="idrow"><span>入學年度</span>${me.enrollYear ? '民國 ' + esc(me.enrollYear) + ' 年' : '—'}</div>
          </div>
        </div>
        <div class="idstats"><div><b id="st-books">–</b>上架中</div><div><b id="st-wishes">–</b>許願中</div><div><b id="st-rating">–</b>賣家評價</div></div>
      </div>`;
    const row = (id, ico, title, subt, right) => `<button id="${id}" class="mrow"><span class="mico">${ico}</span><span class="mtxt"><b>${title}</b>${subt ? `<small>${subt}</small>` : ''}</span>${right || ''}<span class="mchev">›</span></button>`;
    $('mine-menu').innerHTML = `<div class="mtitle">帳號</div>
      <div class="mgroup">
        ${row('btn-edit-profile', '👤', '編輯個人資料', '管理暱稱與系所')}
        ${me.verified ? row('btn-open-favs', '♥', '我的收藏', dropCount() ? '有 ' + dropCount() + ' 本降價了!' : '收藏的書降價會提醒你', dropCount() ? `<span class="mbadge mb-wait">降價</span>` : '') : ''}
        ${me.verified ? row('btn-open-trades', '🧾', '交易紀錄', '買過、賣過的書與金額') : ''}
        ${row('btn-open-verify', '🛡️', '學校認證', sub, `<span class="mbadge ${badge[1]}">${badge[0]}</span>`)}
        ${me.verified && !me.isAdmin ? row('btn-open-cred', '🔑', '登入帳號與密碼', me.ownLoginSet ? '可更換 Email 或密碼' : '請設定你的 Email 與密碼', `<span class="mbadge ${me.ownLoginSet ? 'mb-ok' : 'mb-wait'}">${me.ownLoginSet ? '已設定' : '未設定'}</span>`) : ''}
      </div>
      <div class="mtitle">設定</div>
      <div class="mgroup">
        ${row('btn-toggle-notify', '🔔', '通知設定', '推播、Email、登入碼')}
        ${row('btn-support-mine', '🎧', '客服與說明', '有問題?聯絡管理員')}
        ${row('btn-logout', '🚪', '登出', '')}
        ${me.isAdmin ? '' : row('btn-delete-account', '🗑️', '刪除帳號與個資', '永久刪除你的所有資料')}
      </div>`;
    $('btn-open-verify').addEventListener('click', openVerify);
    if ($('btn-open-cred')) $('btn-open-cred').addEventListener('click', openCred);
    if ($('btn-open-favs')) $('btn-open-favs').addEventListener('click', openFavs);
    if ($('btn-open-trades')) $('btn-open-trades').addEventListener('click', () => openTrades('buy'));
    if ($('btn-delete-account')) $('btn-delete-account').addEventListener('click', deleteAccount);
    $('btn-toggle-notify').addEventListener('click', () => $('mine-notify').classList.toggle('hidden'));
    $('btn-support-mine').addEventListener('click', () => $('btn-support').click());
  }

  // ---------- 通知設定 ----------
  async function renderNotify() {
    const box = $('mine-notify');
    if (!me) { box.innerHTML = ''; return; }
    let ps = 'unsupported';
    try { ps = await API.pushState(); } catch (e) { /* ignore */ }
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone;
    let pushHint, pushBtn = '';
    if (ps === 'on') { pushHint = '已開啟:有新訊息時,這台裝置會收到通知。'; pushBtn = '<button id="btn-push" class="btn btn-ghost btn-sm">關閉</button>'; }
    else if (ps === 'off') { pushHint = '有新訊息時,即使沒開網站也會通知你。'; pushBtn = '<button id="btn-push" class="btn btn-primary btn-sm">開啟</button>'; }
    else if (ps === 'denied') pushHint = '你已在瀏覽器封鎖通知,請到瀏覽器的網站設定中允許通知。';
    else if (API.DEMO) pushHint = '示範模式不支援。';
    else if (ios && !standalone) pushHint = 'iPhone 請先用 Safari 點「分享」→「加入主畫面」,再從主畫面開啟本站,即可開啟通知。';
    else pushHint = '這個瀏覽器或目前模式不支援推播通知。';

    const emailHint = API.DEMO ? '示範模式不支援。'
      : me.hasEmail ? '新訊息時寄信通知你(信中不含聊天內容)。' : '你的 LINE 帳號沒有提供 email,無法使用 Email 通知。';
    box.innerHTML = `<h2 class="h-sec">🔔 通知設定</h2>
      <div class="surface">
        <div class="p-4 flex items-center gap-3"><div class="flex-1 min-w-0"><div class="font-extrabold text-sm">瀏覽器推播通知</div><div class="text-xs" style="color:var(--muted)">${esc(pushHint)}</div></div>${pushBtn}</div>
        <div class="p-4 flex items-center gap-3" style="border-top:1px solid var(--line)"><div class="flex-1 min-w-0"><div class="font-extrabold text-sm">Email 通知</div><div class="text-xs" style="color:var(--muted)">${esc(emailHint)}</div></div>
          <input id="chk-email" type="checkbox" style="accent-color:var(--brand-b);width:22px;height:22px" ${me.notifyEmail ? 'checked' : ''} ${me.hasEmail && !API.DEMO ? '' : 'disabled'}></div>
      </div>
      <div class="surface mt-3"><div class="p-4 flex items-center gap-3"><div class="flex-1 min-w-0"><div class="font-extrabold text-sm">登入碼</div><div class="text-xs" style="color:var(--muted)" id="code-out">要在主畫面 App 登入?先在這裡產生 6 位數登入碼(3 分鐘內、限用一次),再到 App 輸入。</div></div>${API.DEMO ? '' : '<button id="btn-code-make" class="btn btn-ghost btn-sm">產生</button>'}</div></div>
      <p class="hint mt-2">通知只會提示「哪本書有新訊息」,不含聊天內容。手機推播每則新訊息都會通知;Email 同一串聊聊 5 分鐘內最多一封。</p>`;
  }

  // ---------- 購買 ----------
  function openBuy(bookId) {
    if (!requireVerified()) return;
    const b = books.find((x) => String(x.id) === bookId);
    if (!b) return;
    buyingId = bookId;
    $('buy-info').innerHTML = `<div class="flex items-center gap-3">
      ${b.image_url ? `<img src="${esc(b.image_url)}" alt="" class="object-cover shrink-0" style="width:64px;height:64px;border-radius:18px">` : `<span class="shrink-0 grid place-items-center text-3xl" style="width:64px;height:64px;border-radius:18px;background:var(--grad-soft)">📖</span>`}
      <div class="flex-1 min-w-0"><div class="font-black leading-snug">${esc(b.title)}</div><div class="font-black text-lg" style="color:var(--brand-b)">NT$ ${esc(b.price)}</div></div></div>`;
    const opts = [];
    if (b.allow_meetup) opts.push(['meetup', '🤝 面交', b.meetup_place ? '建議地點:' + b.meetup_place : '時間地點在聊聊中約定']);
    if (b.allow_shipping) opts.push(['shipping', '📦 寄送', b.shipping_fee > 0 ? '運費 NT$ ' + b.shipping_fee : '免運費']);
    $('buy-methods').innerHTML = '<legend class="label">選擇交易方式</legend>' + opts.map((o, i) => `
      <label class="method">
        <input type="radio" name="method" value="${o[0]}" ${i === 0 ? 'checked' : ''}>
        <span><span class="font-extrabold">${o[1]}</span><br><span class="text-xs" style="color:var(--muted)">${esc(o[2])}</span></span>
      </label>`).join('');
    hide('buy-error');
    show('modal-buy');
  }

  async function submitBuy(e) {
    e.preventDefault();
    const method = e.target.elements.method.value;
    const btn = $('btn-buy-submit');
    btn.disabled = true;
    try {
      const id = await API.startThread(buyingId, method);
      hide('modal-buy');
      await openThread(id);
    } catch (ex) {
      $('buy-error').textContent = ex.message || '無法建立聊聊';
      show('buy-error');
    } finally { btn.disabled = false; }
  }

  async function helpWish(wishId) {
    if (!requireVerified()) return;
    try { await openThread(await API.startWishThread(wishId)); }
    catch (ex) { toast(ex.message || '無法建立聊聊'); }
  }

  // ---------- 上架 / 許願 ----------
  function cooldown(key, errEl) {
    const last = Number(localStorage.getItem(key) || 0);
    if (Date.now() - last < 30000) { errEl.textContent = '操作太頻繁,請稍後再試'; errEl.classList.remove('hidden'); return false; }
    return true;
  }

  const MAX_PHOTOS = 5;

  function renderSellPhotos() {
    $('sell-photos').innerHTML = keepImages.map((u, i) => `<div class="relative" style="width:64px;height:64px">
      <img src="${esc(u)}" alt="" class="object-cover" style="width:64px;height:64px;border-radius:14px">
      <button type="button" data-rm-photo="${i}" class="absolute grid place-items-center font-black" style="top:-6px;right:-6px;width:22px;height:22px;border-radius:50%;background:var(--text);color:var(--surface);font-size:13px">×</button>
      ${i === 0 ? '<span class="absolute text-[10px] font-black" style="left:4px;bottom:3px;color:#fff;text-shadow:0 1px 3px #000">封面</span>' : ''}</div>`).join('');
  }

  // 開啟上架表單;book 有值時是「編輯」
  function openSell(book) {
    const form = $('form-sell');
    form.reset();
    hide('form-error');
    editingBook = book || null;
    keepImages = book ? [book.image_url].concat(book.extra_images || []).filter(Boolean) : [];
    if (book) {
      const f = form.elements;
      f.title.value = book.title; f.price.value = book.price; f.teacher.value = book.teacher || '';
      f.course_dept.value = book.course_dept || ''; f.course.value = book.course || ''; f.author.value = book.author || '';
      f.note.value = book.note || ''; f.allow_meetup.checked = !!book.allow_meetup; f.allow_shipping.checked = !!book.allow_shipping;
      f.meetup_place.value = book.meetup_place || ''; f.shipping_fee.value = book.shipping_fee ? book.shipping_fee : '';
      f.condition.value = book.condition || ''; f.isbn.value = book.isbn || ''; f.publisher.value = book.publisher || ''; f.edition.value = book.edition || ''; f.pub_year.value = book.pub_year || '';
    }
    form.querySelector('h2.title').textContent = book ? '✏️ 編輯上架' : '📖 上架二手書';
    $('btn-submit').textContent = book ? '儲存修改' : '送出上架';
    renderSellPhotos();
    show('modal-sell');
  }

  async function submitSell(e) {
    e.preventDefault();
    const f = e.target.elements;
    const err = $('form-error');
    err.classList.add('hidden');
    if (f.website.value) return;
    if (!me || !me.verified) { requireVerified(); return; }
    if (!f.allow_meetup.checked && !f.allow_shipping.checked) {
      err.textContent = '請至少選擇一種交易方式'; err.classList.remove('hidden'); return;
    }
    if (f.allow_meetup.checked && !f.meetup_place.value) {
      err.textContent = '請選擇面交地點(只能從清單選擇)'; err.classList.remove('hidden'); return;
    }
    if (!f.teacher.value.trim() && !f.course_dept.value) {
      err.textContent = '請填寫老師名稱或選擇開課系所(至少一項)'; err.classList.remove('hidden'); return;
    }
    const files = Array.from(f.image.files || []);
    if (keepImages.length + files.length === 0) { err.textContent = '請至少放一張書籍照片'; err.classList.remove('hidden'); return; }
    if (keepImages.length + files.length > MAX_PHOTOS) { err.textContent = '照片最多 ' + MAX_PHOTOS + ' 張(目前 ' + (keepImages.length + files.length) + ' 張)'; err.classList.remove('hidden'); return; }
    if (!editingBook && !cooldown('last_post', err)) return;

    const btn = $('btn-submit');
    btn.disabled = true; btn.textContent = editingBook ? '儲存中…' : '上傳中…';
    try {
      const uploaded = [];
      for (const file of files) uploaded.push(await API.uploadImage(file));
      const all = keepImages.concat(uploaded);
      const row = {
        title: f.title.value.trim(), author: f.author.value.trim(), course: f.course.value.trim(),
        teacher: f.teacher.value.trim(), course_dept: f.course_dept.value,
        price: parseInt(f.price.value, 10), image_url: all[0],
        note: f.note.value.trim(),
        allow_meetup: f.allow_meetup.checked, allow_shipping: f.allow_shipping.checked,
        meetup_place: f.allow_meetup.checked ? f.meetup_place.value : '',
        shipping_fee: f.shipping_fee.value === '' ? 0 : parseInt(f.shipping_fee.value, 10),
        condition: f.condition.value, isbn: f.isbn.value.replace(/[^0-9Xx-]/g, '').slice(0, 17), publisher: f.publisher.value.trim(), edition: f.edition.value.trim(),
        pub_year: f.pub_year.value ? parseInt(f.pub_year.value, 10) : null
      };
      const wasEdit = !!editingBook;
      if (wasEdit) {
        row.extra_images = all.slice(1);
        await API.updateBook(editingBook.id, row);
        await API.updateBookMeta(editingBook.id, row);
      } else {
        if (all.length > 1) row.extra_images = all.slice(1);
        await API.addBook(row);
        localStorage.setItem('last_post', String(Date.now()));
      }
      editingBook = null; keepImages = [];
      e.target.reset();
      hide('modal-sell');
      toast(wasEdit ? '✅ 已儲存修改' : '✅ 上架成功!');
      await loadBooks();
      if (wasEdit) renderMine(); else tab = 'books';
      render();
    } catch (ex) {
      console.error(ex);
      err.textContent = (editingBook ? '儲存失敗:' : '上架失敗:') + (ex.message || '請稍後再試');
      err.classList.remove('hidden');
    } finally { btn.disabled = false; btn.textContent = editingBook ? '儲存修改' : '送出上架'; }
  }

  // 看一本書的所有照片
  function openPhotos(b) {
    addRecent(b.id);
    const urls = [b.image_url].concat(b.extra_images || []).filter(Boolean);
    $('photos-title').textContent = b.title;
    $('photos-strip').innerHTML = urls.map((u) => `<img src="${esc(u)}" alt="" style="flex:none;${urls.length > 1 ? 'width:86%;' : 'width:100%;'}scroll-snap-align:center;border-radius:18px;object-fit:cover;max-height:50vh">`).join('');
    $('photos-hint').classList.toggle('hidden', urls.length < 2);
    const row = (ico, label, val) => (val ? `<div class="text-sm"><span style="color:var(--muted)">${ico} ${label}</span>　<b>${esc(val)}</b></div>` : '');
    const methods = [b.allow_meetup ? '🤝 面交' + (b.meetup_place ? '(建議:' + b.meetup_place + ')' : '') : '', b.allow_shipping ? '📦 寄送' + (b.shipping_fee > 0 ? '(運費 NT$ ' + b.shipping_fee + ')' : '(免運費)') : ''].filter(Boolean).join('、');
    $('detail-body').innerHTML = `
      <div class="flex items-center justify-between gap-2"><div class="font-black text-xl" style="color:var(--brand-b)">NT$ ${esc(b.price)}</div><span class="pill ${b.status === 'active' ? 'pill-ok' : 'pill-mute'}">${BOOK_ST[b.status] || ''}</span></div>
      ${row('📘', '課程', b.course)}${row('✍️', '作者', b.author)}${row('🎓', '老師', b.teacher)}${row('🏫', '開課系所', b.course_dept)}
      ${row('📖', '書況', b.condition)}${row('🔖', 'ISBN', b.isbn)}${row('🏢', '出版社', b.publisher)}${row('📅', '出版年份', b.pub_year)}${row('♻️', '版本', b.edition)}
      ${row('⭐', '賣家評價', b.rating ? b.rating.avg.toFixed(1) + ' 顆星(' + b.rating.cnt + ' 筆)' : '尚無評價')}${row('🔁', '交易方式', methods)}
      ${b.note ? `<div class="box text-sm" style="white-space:pre-wrap"><div style="color:var(--muted)" class="text-xs mb-1">📝 備註</div>${esc(b.note)}</div>` : ''}
      ${me && me.id === b.seller_id ? '' : `<div class="flex flex-wrap gap-2"><button data-fav-detail="${esc(b.id)}" class="btn btn-ghost btn-sm">${favIds.has(String(b.id)) ? '♥ 已收藏' : '♡ 收藏'}</button><button data-seller="${esc(b.seller_id)}" class="btn btn-ghost btn-sm">🧑‍🎓 看賣家</button><button data-report-book="${esc(b.id)}" class="btn btn-ghost btn-sm">🚩 檢舉</button></div>`}
      ${b.status === 'active' && !(me && me.id === b.seller_id) ? `<button data-detail-buy="${esc(b.id)}" class="btn btn-primary btn-block !py-3">我想買</button>` : ''}`;
    show('modal-photos');
  }

  function openWish(title) {
    if (!requireVerified()) return;
    $('form-wish').elements.title.value = title || '';
    show('modal-wish');
  }

  async function submitWish(e) {
    e.preventDefault();
    const f = e.target.elements;
    const err = $('wish-error');
    err.classList.add('hidden');
    if (f.website.value) return;
    if (!me || !me.verified) { requireVerified(); return; }
    if (!cooldown('last_wish', err)) return;

    const btn = $('btn-wish-submit');
    btn.disabled = true; btn.textContent = '送出中…';
    try {
      const file = f.image.files[0];
      const image_url = file ? await API.uploadImage(file) : '';
      await API.addWish({
        image_url: image_url, title: f.title.value.trim(), course: f.course.value.trim(),
        budget: f.budget.value === '' ? null : parseInt(f.budget.value, 10), note: f.note.value.trim()
      });
      localStorage.setItem('last_wish', String(Date.now()));
      e.target.reset();
      hide('modal-wish');
      toast('🙏 許願成功!有人有書會在聊聊找你');
      wishes = await API.listWishes();
      tab = 'wishes';
      render();
    } catch (ex) {
      console.error(ex);
      err.textContent = '許願失敗:' + (ex.message || '請稍後再試');
      err.classList.remove('hidden');
    } finally { btn.disabled = false; btn.textContent = '送出許願'; }
  }

  // ---------- 頁籤 ----------
  async function setTab(t) {
    if (t === 'chat' && !requireVerified()) return;
    if (t === 'mine' && !requireLogin()) return;
    tab = t;
    if (t === 'chat') { await loadThreads(); }
    render();
  }

  // ---------- 事件 ----------
  $('search').addEventListener('input', render);
  document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
  $('btn-sell').addEventListener('click', () => { if (requireVerified()) openSell(null); });
  document.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.nav)));
  $('fab').addEventListener('click', () => { if (tab === 'wishes') openWish(''); else if (requireVerified()) openSell(null); });
  $('btn-wish').addEventListener('click', () => openWish(''));
  $('btn-wish-empty').addEventListener('click', () => openWish($('search').value.trim()));
  const isStandalone = () => navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  // 主畫面 App 內先顯示登入視窗(可輸入登入碼);一般瀏覽器維持直接前往 LINE 登入
  $('btn-login').addEventListener('click', () => { if (API.DEMO) API.login(); else show('modal-login'); });
  $('form-cred').addEventListener('submit', submitCred);
  document.querySelectorAll('[data-close-cred]').forEach((el) => el.addEventListener('click', () => hide('modal-cred')));
  $('form-pwlogin').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('btn-pw-go'); btn.disabled = true; hide('pw-error');
    try { await API.loginWithPassword($('pw-email').value, $('pw-pass').value); location.reload(); }
    catch (ex) { $('pw-error').textContent = ex.message || '登入失敗'; show('pw-error'); }
    finally { btn.disabled = false; }
  });
  $('btn-code-toggle').addEventListener('click', () => $('code-box').classList.toggle('hidden'));
  $('btn-code-go').addEventListener('click', async () => {
    const v = $('code-input').value.trim();
    if (!v) { toast('請輸入登入碼'); return; }
    try { await API.loginWithCode(v); location.reload(); }
    catch (ex) { toast(ex.message || '登入失敗'); }
  });
  $('btn-login-go').addEventListener('click', () => API.login());
  $('btn-me').addEventListener('click', () => setTab('mine'));
  $('pager').addEventListener('click', (e) => {
    const b = e.target.closest('[data-page]');
    if (!b || b.disabled) return;
    bookPage = Number(b.dataset.page); renderBooks();
    const top = document.getElementById('view-books').getBoundingClientRect().top + window.scrollY - 70;
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  });
  $('btn-sold').addEventListener('click', () => { showSold = !showSold; bookPage = 1; renderBooks(); });
  $('btn-demo-books').addEventListener('click', () => { if (demoBooks.length) { demoStop(); toast('已移除示範書'); } else { demoStart(); toast('已加入 30 本示範書(只有你看得到,3 分鐘後自動消失)'); } });
  // 示範書不能點進去買或下架
  $('grid').addEventListener('click', (e) => {
    const t = e.target.closest('[data-detail],[data-buy],[data-admin-hide],[data-fav]');
    const id = t && (t.dataset.detail || t.dataset.buy || t.dataset.adminHide || t.dataset.fav);
    if (id && String(id).indexOf('demo-') === 0) { e.stopImmediatePropagation(); toast('這是示範書(只有管理員看得到),不能操作'); }
  }, true);
  // ---------- 進階篩選、搜尋紀錄 ----------
  ['adv-min', 'adv-max'].forEach((id) => $(id).addEventListener('input', () => renderBooks()));
  $('adv-cond').addEventListener('change', () => renderBooks());
  $('adv-clear').addEventListener('click', () => { $('adv-min').value = ''; $('adv-max').value = ''; $('adv-cond').value = ''; renderBooks(); });
  let searchLogTimer = 0;
  $('search').addEventListener('input', () => {
    clearTimeout(searchLogTimer);
    searchLogTimer = setTimeout(() => { const q = $('search').value.trim(); if (q.length >= 2 && !API.DEMO) API.logSearch(q, filteredBooks().length); }, 1500);
  });
  // ---------- 收藏 ----------
  $('grid').addEventListener('click', (e) => { const f = e.target.closest('[data-fav]'); if (f) { e.stopPropagation(); toggleFav(f.dataset.fav); } });
  document.querySelectorAll('[data-close-favs]').forEach((el) => el.addEventListener('click', () => hide('modal-favs')));
  document.querySelectorAll('[data-close-seller]').forEach((el) => el.addEventListener('click', () => hide('modal-seller')));
  document.querySelectorAll('[data-close-trades]').forEach((el) => el.addEventListener('click', () => hide('modal-trades')));
  $('favs-list').addEventListener('click', async (e) => {
    const del = e.target.closest('[data-fav-del]');
    if (del) { await toggleFav(del.dataset.favDel); openFavs(); return; }
    const op = e.target.closest('[data-fav-open]');
    if (op) { const f = favs.find((x) => String(x.book_id) === op.dataset.favOpen); const b = books.find((x) => String(x.id) === op.dataset.favOpen) || (f && f.book); if (b) { hide('modal-favs'); openPhotos(b); } }
  });
  $('seller-body').addEventListener('click', (e) => {
    const op = e.target.closest('[data-seller-book]');
    const b = op && books.find((x) => String(x.id) === op.dataset.sellerBook);
    if (b) { hide('modal-seller'); openPhotos(b); }
  });
  $('trade-seg').addEventListener('click', (e) => { const b = e.target.closest('[data-trade-tab]'); if (b) openTrades(b.dataset.tradeTab); });
  $('trade-body').addEventListener('click', (e) => { const r = e.target.closest('[data-trade-open]'); if (r) { hide('modal-trades'); openThread(r.dataset.tradeOpen); } });
  // ---------- 通知中心、教材專區、最近瀏覽、爭議 ----------
  $('btn-bell').addEventListener('click', openNotif);
  document.querySelectorAll('[data-close-notif]').forEach((el) => el.addEventListener('click', () => { hide('modal-notif'); refreshNotifCount(); }));
  $('btn-notif-readall').addEventListener('click', async () => { try { await API.markNotificationsRead(null); } catch (e) { /* ignore */ } await openNotif(); refreshNotifCount(); });
  $('notif-list').addEventListener('click', (e) => { const b = e.target.closest('[data-notif]'); if (b) clickNotif(b.dataset.notif); });
  $('notif-prefs').addEventListener('change', async (e) => { const c = e.target.closest('[data-pref]'); if (!c) return; try { await API.setNotifPref(c.dataset.pref, c.checked); toast(c.checked ? '已開啟' : '已關閉'); } catch (ex) { c.checked = !c.checked; toast(ex.message || '設定失敗'); } });
  $('btn-zone').addEventListener('click', openZone);
  document.querySelectorAll('[data-close-zone]').forEach((el) => el.addEventListener('click', () => hide('modal-zone')));
  $('zone-sem').addEventListener('change', renderZone);
  $('zone-dept').addEventListener('change', renderZone);
  $('zone-list').addEventListener('click', (e) => {
    const f = e.target.closest('[data-zone-find]'), w = e.target.closest('[data-zone-wish]');
    if (f) { hide('modal-zone'); $('search').value = f.dataset.zoneFind; setTab('books'); renderBooks(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
    else if (w) { hide('modal-zone'); openWish(w.dataset.zoneWish); }
  });
  $('recent-box').addEventListener('click', (e) => {
    if (e.target.closest('[data-recent-clear]')) { try { localStorage.removeItem('cb_recent'); } catch (x) { /* ignore */ } renderRecent(); return; }
    const c = e.target.closest('[data-recent]'); const bk = c && books.find((x) => String(x.id) === c.dataset.recent); if (bk) openPhotos(bk);
  });
  document.querySelectorAll('[data-close-dispute]').forEach((el) => el.addEventListener('click', () => hide('modal-dispute')));
  $('form-dispute').addEventListener('submit', submitDispute);
  const topBtn = $('btn-top');
  window.addEventListener('scroll', () => topBtn.classList.toggle('hidden', window.scrollY < 900), { passive: true });
  topBtn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  $('btn-support').addEventListener('click', async () => {
    if (!requireVerified()) return;
    try { await openThread(await API.startSupportThread()); }
    catch (ex) { toast(ex.message || '無法開啟客服對話'); }
  });
  document.querySelectorAll('[data-close-login]').forEach((el) => el.addEventListener('click', () => hide('modal-login')));
  document.querySelectorAll('[data-close-buy]').forEach((el) => el.addEventListener('click', () => hide('modal-buy')));
  document.querySelectorAll('[data-close-sell]').forEach((el) => el.addEventListener('click', () => { hide('modal-sell'); hide('form-error'); editingBook = null; }));
  document.querySelectorAll('[data-close-wish]').forEach((el) => el.addEventListener('click', () => { hide('modal-wish'); hide('wish-error'); }));
  $('form-buy').addEventListener('submit', submitBuy);
  $('form-sell').addEventListener('submit', submitSell);
  $('sell-photos').addEventListener('click', (e) => {
    const rm = e.target.closest('[data-rm-photo]');
    if (rm) { keepImages.splice(Number(rm.dataset.rmPhoto), 1); renderSellPhotos(); }
  });
  $('grid').addEventListener('click', (e) => {
    if (e.target.closest('button, a')) return;      // 按鈕(我想買、管理員下架)照原本處理
    const card = e.target.closest('[data-detail]');
    const bk = card && books.find((x) => String(x.id) === card.dataset.detail);
    if (bk) openPhotos(bk);
  });
  $('detail-body').addEventListener('click', (e) => {
    const bb = e.target.closest('[data-detail-buy]');
    if (bb) { hide('modal-photos'); openBuy(bb.dataset.detailBuy); }
    const rb = e.target.closest('[data-report-book]');
    if (rb) { hide('modal-photos'); openReport({ type: 'book', id: rb.dataset.reportBook }); }
    const fb = e.target.closest('[data-fav-detail]');
    if (fb) toggleFav(fb.dataset.favDetail).then(() => { fb.textContent = favIds.has(fb.dataset.favDetail) ? '♥ 已收藏' : '♡ 收藏'; });
    const sb2 = e.target.closest('[data-seller]');
    if (sb2) { hide('modal-photos'); openSeller(sb2.dataset.seller); }
  });
  document.querySelectorAll('[data-close-photos]').forEach((el) => el.addEventListener('click', () => hide('modal-photos')));
  $('form-profile').addEventListener('submit', submitProfile);
  $('form-consent').addEventListener('submit', submitConsent);
  document.addEventListener('click', (e) => { if (e.target.closest('[data-refresh]')) refreshAll(); });
  $('install-card').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-inst]');
    if (!b) return;
    const act = b.dataset.inst;
    if (act === 'dismiss') { markDismissed(b.dataset.key); renderInstallCard(); return; }
    if (act === 'copy') {
      const url = location.origin + location.pathname;
      try { await navigator.clipboard.writeText(url); toast('已複製網址,到 Safari 貼上開啟'); } catch (err) { toast(url); }
      return;
    }
    if (act === 'install' && deferredInstall) {
      deferredInstall.prompt();
      try { await deferredInstall.userChoice; } catch (err) { /* ignore */ }
      deferredInstall = null; renderInstallCard(); return;
    }
    if (act === 'push') {
      try { await API.enablePush(); toast('✅ 已開啟通知'); renderInstallCard(); if (tab === 'mine') renderMine(); }
      catch (ex) { toast(ex.message || '無法開啟通知'); }
    }
  });
  $('consent-body').addEventListener('scroll', checkConsentScroll);
  $('consent-check').addEventListener('change', updateConsentBtn);
  $('consent-decline').addEventListener('click', async () => {
    await API.disablePush().catch(() => {});
    await API.logout(); me = null; threads = []; unread = {}; cur = null;
    hide('modal-consent'); renderHeader(); tab = 'books'; render(); toast('你選擇不同意,已登出');
  });
  $('ann-banner').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ann-close]');
    if (!b) return;
    const list = dismissedAnn(); list.push(Number(b.dataset.annClose));
    try { localStorage.setItem('dismissed_ann', JSON.stringify(list)); } catch (err) { /* ignore */ }
    renderAnn();
  });
  document.querySelectorAll('[data-close-profile]').forEach((el) => el.addEventListener('click', () => hide('modal-profile')));
  $('form-wish').addEventListener('submit', submitWish);
  $('chat-form').addEventListener('submit', sendChat);
  $('chat-back').addEventListener('click', closeThread);

  $('grid').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-buy]');
    if (btn) { openBuy(btn.dataset.buy); return; }
    const hb = e.target.closest('[data-admin-hide]');
    if (hb) {
      const reason = prompt('下架這本書?\n可填寫原因(選填,會通知進行中的買家)。按「取消」可中止。', '');
      if (reason === null) return;
      try { await API.adminSetBookHidden(hb.dataset.adminHide, true, reason); await loadBooks(); render(); toast('已下架'); }
      catch (ex) { toast(ex.message || '下架失敗'); }
    }
  });
  $('wish-grid').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-wish-help]');
    if (btn) helpWish(btn.dataset.wishHelp);
  });
  $('chips').addEventListener('click', (e) => {
    const c = e.target.closest('[data-quick]');
    if (!c) return;
    quick = c.dataset.quick;
    renderBooks();
  });
  $('thread-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-thread]');
    if (btn) openThread(btn.dataset.thread);
  });
  $('chat-actions').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'meetup') openMeetup();
    else if (btn.dataset.act === 'report') openReport({ type: 'thread', id: cur });
    else if (btn.dataset.act === 'dispute') openDispute(cur);
    else if (btn.dataset.act === 'rate') openRate(cur);
    else threadAction(btn.dataset.act);
  });
  $('chat-book').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-bookst]');
    if (btn) setBookFromChat(btn.dataset.bookst);
  });
  $('form-meetup').addEventListener('submit', submitMeetup);
  document.querySelectorAll('[data-close-meetup]').forEach((el) => el.addEventListener('click', () => hide('modal-meetup')));

  $('view-mine').addEventListener('click', async (e) => {
    if (e.target.closest('#btn-edit-profile')) { openProfile(true); return; }
    if (e.target.closest('#btn-edit-avatar')) {
      const box = $('avatar-picker');
      box.innerHTML = '<div class="text-xs mb-2" style="color:var(--muted)">選一個圖示當頭像(不會使用你的 LINE 頭貼)</div><div class="flex flex-wrap gap-2">' +
        ['👤', '🐱', '🐶', '🐰', '🐻', '🦊', '🐼', '🐨', '🐯', '🦁', '🐸', '🐧', '🦉', '🐢', '🐙', '🦄', '🌸', '🌻', '🍀', '⭐', '🌙', '☁️', '📚', '🎧', '☕', '🍙', '🎈', '🚀']
          .map((x) => `<button type="button" data-avatar="${x === '👤' ? '' : 'e:' + x}" class="btn btn-ghost" style="width:46px;height:46px;font-size:24px;padding:0">${x}</button>`).join('') + '</div>';
      box.classList.toggle('hidden');
      return;
    }
    const be = e.target.closest('[data-book-edit]');
    if (be) { const bk = mineBooks.find((x) => String(x.id) === be.dataset.bookEdit); if (bk) openSell(bk); return; }
    const av = e.target.closest('[data-avatar]');
    if (av) {
      try { await API.setAvatar(av.dataset.avatar); me.picture = av.dataset.avatar; $('avatar-picker').classList.add('hidden'); renderMine(); toast('頭像已更新'); }
      catch (ex) { toast(ex.message || '更新失敗'); }
      return;
    }
    const pb = e.target.closest('#btn-push');
    if (pb) {
      pb.disabled = true;
      try {
        if ((await API.pushState()) === 'on') { await API.disablePush(); toast('已關閉通知'); }
        else { await API.enablePush(); toast('✅ 已開啟通知'); }
      } catch (ex) { toast(ex.message || '操作失敗'); }
      renderNotify();
      return;
    }
    const ck = e.target.closest('#chk-email');
    if (ck) {
      try { await API.setNotifyEmail(ck.checked); me.notifyEmail = ck.checked; toast(ck.checked ? '已開啟 Email 通知' : '已關閉 Email 通知'); }
      catch (ex) { ck.checked = !ck.checked; toast(ex.message || '操作失敗'); }
      return;
    }
    if (e.target.closest('#btn-code-make')) {
      try {
        const c = await API.createLoginCode();
        $('code-out').innerHTML = '登入碼:<b style="font-size:20px;letter-spacing:2px;color:var(--brand-b)">' + esc(c.slice(0, 3) + ' ' + c.slice(3)) + '</b>(3 分鐘內有效,限用一次;請勿告訴別人)';
      } catch (ex) { toast(ex.message || '產生失敗'); }
      return;
    }
    if (e.target.closest('#btn-logout')) {
      await API.disablePush().catch(() => {});
      await API.logout(); me = null; unread = {}; threads = []; cur = null; renderHeader(); tab = 'books'; render(); toast('已登出');
      return;
    }
    const b = e.target.closest('[data-book-status]');
    const w = e.target.closest('[data-wish-status]');
    try {
      if (b) { await API.setBookStatus(b.dataset.id, b.dataset.bookStatus); await loadBooks(); }
      if (w) { await API.setWishStatus(w.dataset.id, w.dataset.wishStatus); wishes = await API.listWishes(); }
      if (b || w) renderMine();
    } catch (ex) { toast(ex.message || '操作失敗'); }
  });

  // ---------- 註冊驗證 / 檢舉 / 評價 / 系所與地點下拉 / 強制登出 ----------
  function fillDeptFilter() {
    const opts = (window.DEPARTMENTS || []).map((d) => `<option>${esc(d)}</option>`).join('');
    $('dept-filter').innerHTML = '<option value="">所有系所的書</option>' + opts;
  }
  function fillPlaces() {
    const opts = places.map((p) => `<option>${esc(p)}</option>`).join('');
    $('sell-place').innerHTML = '<option value="">選擇面交地點…</option>' + opts;
    $('meetup-place').innerHTML = '<option value="" disabled selected>選擇面交地點…</option>' + opts;
  }

  // ---------- 註冊第一步:基本資料(姓名、科系、入學年度) ----------
  function rocYears() {
    const d = new Date();
    const top = d.getMonth() >= 7 ? d.getFullYear() - 1911 : d.getFullYear() - 1912;   // 8 月起算新學年度
    const out = [];
    for (let y = top; y >= top - 9; y--) out.push(y);
    return out;
  }
  function openBasic() {
    $('basic-dept').innerHTML = '<option value="">請選擇科系</option>' + (window.DEPARTMENTS || []).map((d) => `<option>${esc(d)}</option>`).join('');
    $('basic-year').innerHTML = '<option value="">請選擇入學年度</option>' + rocYears().map((y) => `<option value="${y}">民國 ${y} 年</option>`).join('');
    $('basic-name').value = (me && me.realName) || '';
    $('basic-dept').value = (me && me.department) || '';
    $('basic-year').value = (me && me.enrollYear) ? String(me.enrollYear) : '';
    hide('basic-error');
    syncBasicBtn();
    show('modal-basic');
  }
  function syncBasicBtn() {
    $('btn-basic-submit').disabled = !($('basic-name').value.trim().length >= 2 && $('basic-dept').value && $('basic-year').value);
  }
  async function submitBasic(e) {
    e.preventDefault();
    const btn = $('btn-basic-submit');
    btn.disabled = true; hide('basic-error');
    try {
      await API.saveBasicInfo($('basic-name').value.trim(), $('basic-dept').value, $('basic-year').value);
      me = await API.me();
      hide('modal-basic');
      toast('✅ 基本資料已儲存');
      if (profileDone()) render(); else openSetup();
    } catch (ex) { $('basic-error').textContent = ex.message || '儲存失敗'; show('basic-error'); }
    finally { syncBasicBtn(); }
  }

  function openVerify() {
    hide('verify-error');
    const pending = me && me.verifyStatus === 'pending';
    $('verify-pending').classList.toggle('hidden', !pending);
    $('verify-form-box').classList.toggle('hidden', !!pending);
    $('vf-bar').classList.toggle('hidden', !!pending);
    syncVerifyBtn();
    if (pending) $('verify-pending-no').textContent = me.studentNo || '';
    const rej = me && me.verifyStatus === 'rejected';
    $('verify-rejected').classList.toggle('hidden', !rej);
    if (rej) $('verify-rejected').textContent = '上次的申請被退回' + (me.verifyNote ? ':' + me.verifyNote : '') + '。請修正後重新送出。';
    show('modal-verify');
  }
  function syncVerifyBtn() {
    $('btn-verify-submit').disabled = !($('verify-no').value.trim().length >= 6 && $('verify-card').files[0] && $('verify-agree').checked);
  }
  function verifyErr(m) { $('verify-error').textContent = m; show('verify-error'); }
  async function submitVerify(e) {
    e.preventDefault();
    const no = $('verify-no').value.trim();
    const file = $('verify-card').files[0];
    if (!no) { verifyErr('請輸入學號'); return; }
    if (!file) { verifyErr('請上傳學生證照片'); return; }
    const btn = $('btn-verify-submit');
    btn.disabled = true; btn.textContent = '送出中…'; hide('verify-error');
    try {
      await API.submitStudentCard(no, file);
      me = await API.me();
      toast('已送出,等待管理員審核');
      if (tab === 'mine') renderMineVerify();
      $('verify-card').value = ''; $('verify-agree').checked = false; $('verify-card-preview').classList.add('hidden'); $('verify-card-empty').classList.remove('hidden');
      openVerify();
    } catch (ex) { verifyErr(ex.message || '送出失敗'); }
    finally { btn.textContent = '送出驗證申請'; syncVerifyBtn(); }
  }
  async function refreshVerify() {
    try {
      const m = await API.me();
      if (!m) return;
      me = m;
      if (me.verified) { hide('modal-verify'); toast('✅ 驗證通過,歡迎使用'); if (profileDone()) render(); else openSetup(); if (!me.ownLoginSet && !me.isAdmin && !API.DEMO) openCred(); return; }
      if (tab === 'mine') renderMineVerify();
      openVerify();
      if (me.verifyStatus === 'pending') toast('還在審核中,請稍後再看');
    } catch (ex) { verifyErr(ex.message || '無法取得狀態'); }
  }

  function openReport(target) {
    if (!requireVerified()) return;
    reportTarget = target;
    $('form-report').reset();
    $('report-target').textContent = target.type === 'book' ? '檢舉這本書(內容不當或與教科書無關)' : '檢舉聊聊中的對方';
    hide('report-error'); show('modal-report');
  }
  async function submitReport(e) {
    e.preventDefault();
    const f = e.target.elements;
    try {
      if (reportTarget.type === 'book') await API.reportBook(reportTarget.id, f.reason.value, f.detail.value.trim());
      else await API.reportThreadUser(reportTarget.id, f.reason.value, f.detail.value.trim());
      hide('modal-report'); toast('✅ 已送出,管理員會處理');
    } catch (ex) { $('report-error').textContent = ex.message || '送出失敗'; show('report-error'); }
  }

  function paintStars() {
    document.querySelectorAll('#rate-stars [data-star]').forEach((b) => { b.textContent = Number(b.dataset.star) <= rateStars ? '★' : '☆'; });
  }
  function openRate(tid) { rateThread = tid; rateStars = 0; $('form-rate').reset(); paintStars(); hide('rate-error'); show('modal-rate'); }
  async function submitRate(e) {
    e.preventDefault();
    if (!rateStars) { $('rate-error').textContent = '請先選擇星數'; show('rate-error'); return; }
    try {
      await API.rateSeller(rateThread, rateStars, e.target.elements.comment.value.trim());
      ratedThreads.add(rateThread); hide('modal-rate'); toast('✅ 謝謝你的評價'); renderChat();
    } catch (ex) { $('rate-error').textContent = ex.message || '送出失敗'; show('rate-error'); }
  }

  // 被管理員停權:顯示原因並強制登出
  async function forceLogout(reason) {
    try { await API.disablePush().catch(() => {}); await API.logout(); } catch (e) { /* ignore */ }
    me = null; unread = {}; threads = []; cur = null; tab = 'books';
    ['modal-sell', 'modal-buy', 'modal-profile', 'modal-verify', 'modal-meetup', 'modal-report', 'modal-rate', 'modal-photos'].forEach(hide);
    renderHeader(); render();
    $('banned-reason').textContent = reason ? '原因:' + reason : '管理員未填寫原因。';
    show('modal-banned');
  }
  async function checkBan() {
    if (!me || me.isAdmin || API.DEMO) return;
    try { const r = await API.checkBanned(me.id); if (r.banned) await forceLogout(r.reason); } catch (e) { /* ignore */ }
  }

  $('dept-filter').addEventListener('change', (e) => { deptSel = e.target.value; renderBooks(); });
  $('btn-verify-refresh').addEventListener('click', refreshVerify);
  $('form-basic').addEventListener('submit', submitBasic);
  ['basic-name', 'basic-dept', 'basic-year'].forEach((id) => $(id).addEventListener('input', syncBasicBtn));
  $('basic-dept').addEventListener('change', syncBasicBtn);
  $('basic-year').addEventListener('change', syncBasicBtn);
  $('btn-basic-close').addEventListener('click', () => hide('modal-basic'));
  $('btn-basic-logout').addEventListener('click', async () => { await API.logout(); me = null; hide('modal-basic'); renderHeader(); tab = 'books'; render(); });
  $('verify-no').addEventListener('input', syncVerifyBtn);
  $('verify-agree').addEventListener('change', syncVerifyBtn);
  $('btn-verify-close').addEventListener('click', () => { hide('modal-verify'); if (tab === 'mine') renderMineVerify(); });
  $('verify-card').addEventListener('change', (ev) => {
    const f = ev.target.files[0], img = $('verify-card-preview');
    if (f) { img.src = URL.createObjectURL(f); img.classList.remove('hidden'); $('verify-card-empty').classList.add('hidden'); } else { img.classList.add('hidden'); $('verify-card-empty').classList.remove('hidden'); }
    syncVerifyBtn();
  });
  $('form-verify').addEventListener('submit', submitVerify);
  $('btn-verify-logout').addEventListener('click', async () => { await API.logout(); me = null; hide('modal-verify'); renderHeader(); tab = 'books'; render(); });
  $('form-report').addEventListener('submit', submitReport);
  document.querySelectorAll('[data-close-report]').forEach((el) => el.addEventListener('click', () => hide('modal-report')));
  $('form-rate').addEventListener('submit', submitRate);
  $('rate-stars').addEventListener('click', (e) => { const b = e.target.closest('[data-star]'); if (b) { rateStars = Number(b.dataset.star); paintStars(); } });
  document.querySelectorAll('[data-close-rate]').forEach((el) => el.addEventListener('click', () => hide('modal-rate')));
  $('btn-banned-ok').addEventListener('click', () => hide('modal-banned'));

  // ---------- 初始化 ----------
  // 網址參數:?q=微積分 帶入搜尋;?tab=wishes / chat / mine;?sell=1、?wish=1 直接開啟表單(給 LINE 選單使用)
  async function init() {
    if (API.DEMO) show('demo-banner');
    fillDepartments();
    fillDeptFilter();
    try { places = await API.listPlaces(); } catch (e) { places = []; }
    fillPlaces();
    if (window.APP_CONFIG.LINE_OA_URL) { $('footer-oa').href = window.APP_CONFIG.LINE_OA_URL; show('footer-oa'); }
    loadAnnouncements();
    try { await API.handleCallback(); } catch (e) { toast(e.message || '登入失敗'); }

    try {
      me = await API.me();
      if (me && me.banned) { pendingBan = me.banReason || ''; await API.logout(); me = null; }
    } catch (e) { console.error(e); }

    const params = new URLSearchParams(location.search);
    if (params.get('q')) $('search').value = params.get('q');
    if (['wishes', 'chat', 'mine'].indexOf(params.get('tab')) !== -1) tab = params.get('tab');
    if (params.get('wish') === '1') tab = 'wishes';
    if (!me && (tab === 'chat' || tab === 'mine')) tab = 'books';

    try { [, wishes] = await Promise.all([loadBooks(), API.listWishes()]); }
    catch (e) { console.error(e); toast('載入失敗,請重新整理'); }
    await loadThreads();
    await refreshUnread();
    hide('loading');
    render();
    renderInstallCard();
    notifyMatches();
    refreshNotifCount();
    if (pendingBan !== null) { $('banned-reason').textContent = pendingBan ? '原因:' + pendingBan : '管理員未填寫原因。'; show('modal-banned'); }
    const tid = params.get('thread');
    if (profileDone() && tid && threads.find((t) => t.id === tid)) await openThread(tid);
    if (profileDone()) API.syncPush().catch(() => {});
    if (me && me.consented) API.subscribeAll(onAnyMessage);   // 即時紅點
    setInterval(() => { refreshUnread(); checkBan(); refreshNotifCount(); }, 15000);                        // 備援:即時推送失敗時,最慢 15 秒內更新
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { refreshUnread(); markCurRead(); checkBan(); } });
    // 從 LINE 機器人點「查看」進來:?book=書的ID
    const bid = params.get('book');
    const wanted = bid && books.find((b) => String(b.id) === bid);
    if (wanted) { $('search').value = wanted.title; render(); }
    if (me && !me.consented) openConsent();
    else if (me && !profileDone()) openSetup();
    else if (wanted && wanted.status === 'active' && me) openBuy(bid);
    else if (params.get('sell') === '1' && requireVerified()) openSell(null);
    if (params.get('wish') === '1') openWish('');
  }
  init();
})();
