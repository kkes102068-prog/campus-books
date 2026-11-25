(function () {
  'use strict';

  const API = window.API;
  const sb = API.sb;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (iso) => { if (!iso) return '—'; const d = new Date(iso); return d.toLocaleString('zh-TW', { hour12: false }); };
  const unwrap = ({ data, error }) => { if (error) throw error; return data; };
  const THREAD_STATUS = { open: '洽談中', accepted: '已確認', completed: '已完成', cancelled: '已取消' };
  const METHOD = { meetup: '面交', shipping: '寄送' };
  const BOOK_STATUS = { active: '未售出', reserved: '交易中', sold: '已售出', hidden: '已下架' };
  let myRole = 'super';
  const TABS = [['overview', '總覽'], ['stats', '📊 營運統計'], ['verify', '🪪 學生證審核'], ['reports', '🚩 檢舉'], ['users', '使用者'], ['logins', '登入紀錄'], ['books', '書籍'], ['wishes', '願望'], ['threads', '交易 / 聊聊'], ['disputes', '⚖️ 交易爭議'], ['textbooks', '📚 學期與教材'], ['broadcast', '📢 廣播公告'], ['places', '交易地點'], ['consent', '同意書'], ['moderation', '處置紀錄'], ['admins', '🔐 管理員權限']];
  let tab = 'overview';
  let me = null;
  let threadCache = [];

  function toast(msg) {
    const t = $('toast');
    t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), 3000);
  }

  function gate(html) {
    $('app').classList.add('hidden');
    $('gate').innerHTML = html;
    $('gate').classList.remove('hidden');
  }

  function table(heads, rows) {
    if (!rows.length) return '<p class="text-sm text-slate-500 py-8 text-center">沒有資料</p>';
    return `<div class="overflow-x-auto bg-white rounded-xl border border-slate-200"><table class="w-full text-sm">
      <thead class="bg-slate-50 text-left text-slate-500"><tr>${heads.map((h) => `<th class="px-3 py-2 whitespace-nowrap font-medium">${h}</th>`).join('')}</tr></thead>
      <tbody class="divide-y divide-slate-100">${rows.map((r) => `<tr>${r.map((c) => `<td class="px-3 py-2 align-top">${c}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div>`;
  }
  const btn = (attrs, label, cls) => `<button ${attrs} class="rounded border px-2 py-0.5 text-xs whitespace-nowrap ${cls || 'border-slate-300'}">${label}</button>`;
  const who = (p) => esc(p && p.display_name);

  // ---------- 各分頁 ----------
  async function count(table_, filter) {
    let q = sb.from(table_).select('*', { count: 'exact', head: true });
    if (filter) q = filter(q);
    const { count: c, error } = await q;
    if (error) throw error;
    return c || 0;
  }

  async function viewOverview() {
    const since = new Date(); since.setHours(0, 0, 0, 0);
    const [users, todayLogins, active, reserved, sold, wishes, tOpen, tAcc, tDone, tCancel, msgs] = await Promise.all([
      count('profiles'),
      count('login_logs', (q) => q.gte('created_at', since.toISOString())),
      count('books', (q) => q.eq('status', 'active')),
      count('books', (q) => q.eq('status', 'reserved')),
      count('books', (q) => q.eq('status', 'sold')),
      count('wishes', (q) => q.eq('status', 'active')),
      count('threads', (q) => q.eq('status', 'open')),
      count('threads', (q) => q.eq('status', 'accepted')),
      count('threads', (q) => q.eq('status', 'completed')),
      count('threads', (q) => q.eq('status', 'cancelled')),
      count('messages')
    ]);
    const [openReports, unverified, pendingCards] = await Promise.all([
      count('reports', (q) => q.eq('status', 'open')),
      count('user_private', (q) => q.eq('student_verified', false)),
      count('user_private', (q) => q.eq('verify_status', 'pending'))
    ]);
    let openDisputes = 0;
    try { openDisputes = await count('transaction_disputes', (q) => q.in('status', ['open', 'investigating'])); } catch (e) { /* 還沒執行 v4 SQL */ }
    const card = (label, v) => `<div class="bg-white rounded-xl border border-slate-200 p-4"><div class="text-xs text-slate-500">${label}</div><div class="text-2xl font-bold">${v}</div></div>`;
    return `<div class="grid grid-cols-2 md:grid-cols-4 gap-3">${card('⚖️ 待處理交易爭議', openDisputes)}
      ${card('註冊使用者', users)}${card('今日登入次數', todayLogins)}${card('未售出的書', active)}${card('交易中', reserved)}
      ${card('已售出', sold)}${card('許願中', wishes)}${card('洽談中交易', tOpen)}${card('已確認交易', tAcc)}
      ${card('已完成交易', tDone)}${card('已取消交易', tCancel)}${card('訊息總數', msgs)}
      ${card('🚩 待處理檢舉', openReports)}${card('尚未驗證在校生', unverified)}${card('🪪 待審核學生證', pendingCards)}</div>`;
  }

  async function viewUsers() {
    const rows = unwrap(await sb.from('profiles')
      .select('id,display_name,banned,ban_reason,created_at,user_private(line_user_id,department,school_email,student_no,real_name,enroll_year,student_verified,last_login_at,login_count),consents(version,signed_at)')
      .order('created_at', { ascending: false }).limit(500));
    let logins = {};
    try { (unwrap(await sb.rpc('admin_user_logins')) || []).forEach((l) => { logins[l.user_id] = l; }); } catch (e) { /* 尚未執行 admin-tools.sql */ }
    return '<p class="text-xs text-slate-500 mb-2">「登入帳號」是同學認證後自己設定的 Email。密碼只以加密雜湊存放,後台看不到;同學忘記密碼時可按「重設密碼」產生臨時密碼。</p>' + table(['使用者', '系所', '學校信箱 / 驗證', '登入帳號', '註冊時間', '最近登入', '登入次數', '同意書', '狀態', '操作'], rows.map((u) => {
      const pr = u.user_private || {};
      return [
        `<div class="font-medium">${esc(u.display_name)}</div><div class="text-[10px] text-slate-400 break-all">${esc(u.id)}</div>`,
        esc(pr.department || '—'),
        pr.student_verified ? `<span class="text-emerald-700 text-xs">已驗證</span><div class="text-[11px] text-slate-500 break-all">${esc((pr.real_name ? pr.real_name + ' / ' : '') + (pr.student_no ? '學號 ' + pr.student_no : (pr.school_email || '(管理員核准)')) + (pr.enroll_year ? ' / 民國' + pr.enroll_year + '入學' : ''))}</div>` : '<span class="text-red-600 text-xs">未驗證</span>',
        logins[u.id] ? `<div class="text-xs break-all font-mono">${esc(logins[u.id].login_email)}</div><div class="text-[11px] text-slate-500">${fmt(logins[u.id].changed_at)} 設定/修改</div>` : '<span class="text-slate-400 text-xs">未設定</span>',
        fmt(u.created_at), fmt(pr.last_login_at), esc(pr.login_count || 0),
        (() => {
          const c = (u.consents || []).slice().sort((a, b) => new Date(b.signed_at) - new Date(a.signed_at))[0];
          return c ? '<span class="text-xs">' + esc(c.version) + '<br>' + fmt(c.signed_at) + '</span>' : '<span class="text-red-600 text-xs">未簽署</span>';
        })(),
        u.banned ? '<span class="text-red-600">已停權</span><div class="text-[11px] text-slate-500 max-w-[10rem] break-words">' + esc(u.ban_reason || '') + '</div>' : '正常',
        `<div class="flex flex-col gap-1">${u.banned ? btn(`data-ban="0" data-id="${esc(u.id)}"`, '解除停權') : btn(`data-ban="1" data-id="${esc(u.id)}"`, '強制剔除(停權)', 'border-red-300 text-red-600')}
         ${pr.student_verified ? btn(`data-revoke="1" data-id="${esc(u.id)}"`, '取消認證', 'border-red-300 text-red-600') : btn(`data-verify="1" data-id="${esc(u.id)}"`, '手動核准為在校生')}
         ${logins[u.id] ? btn(`data-pwreset="1" data-id="${esc(u.id)}"`, '重設密碼') : ''}</div>`
      ];
    }));
  }

  // ---------- 學生證審核 ----------
  async function viewVerify() {
    const rows = unwrap(await sb.from('user_private')
      .select('user_id,student_no,verify_card_path,verify_submitted_at,department,real_name,enroll_year,profiles(display_name)')
      .eq('verify_status', 'pending').order('verify_submitted_at', { ascending: true }).limit(200));
    const urls = await Promise.all(rows.map(async (r) => {
      if (!r.verify_card_path) return '';
      const { data } = await sb.storage.from('student-cards').createSignedUrl(r.verify_card_path, 600);
      return (data && data.signedUrl) || '';
    }));
    return '<p class="text-xs text-slate-500 mb-2">核對學生證上的學號、學校名稱與申請的學號是否一致。通過或退回後,照片會立即從系統刪除。照片連結 10 分鐘內有效,逾時請重新整理。</p>' +
      table(['送出時間', '申請人資料(請與學生證核對)', '學生證', '操作'], rows.map((r, i) => [
        fmt(r.verify_submitted_at),
        `<div class="text-sm leading-6"><div>姓名:<b>${esc(r.real_name || '(未填)')}</b></div><div>學號:<b class="font-mono text-base">${esc(r.student_no)}</b></div><div>科系:${esc(r.department || '—')}</div><div>入學年度:${r.enroll_year ? '民國 ' + esc(r.enroll_year) + ' 年' : '—'}</div><div class="text-xs text-slate-400">暱稱:${who(r.profiles)}</div></div>`,
        urls[i] ? `<a href="${esc(urls[i])}" target="_blank" rel="noopener"><img src="${esc(urls[i])}" class="rounded border max-h-48 max-w-xs" alt="學生證"></a>` : '<span class="text-red-600 text-xs">找不到照片</span>',
        `<div class="flex flex-col gap-1">${btn(`data-vr="1" data-id="${esc(r.user_id)}" data-path="${esc(r.verify_card_path)}"`, '✅ 通過', 'border-emerald-400 text-emerald-700')}${btn(`data-vr="0" data-id="${esc(r.user_id)}" data-path="${esc(r.verify_card_path)}"`, '退回', 'border-red-300 text-red-600')}</div>`
      ]));
  }

  // ---------- 檢舉 ----------
  async function viewReports() {
    const rows = unwrap(await sb.from('reports').select(
      'id,target_type,book_id,target_user_id,reason,detail,status,handled_note,created_at,reporter:profiles!reporter_id(display_name),target:profiles!target_user_id(display_name,banned),book:books(id,title,status)')
      .order('created_at', { ascending: false }).limit(500));
    const counts = {};
    rows.forEach((r) => { counts[r.target_user_id] = (counts[r.target_user_id] || 0) + 1; });
    const REASON = { irrelevant: '不是教科書 / 無關', fraud: '詐騙或不實', harassment: '騷擾或不當言論', illegal: '違法或違規', other: '其他' };
    const line = (r, actions) => [
      fmt(r.created_at), who(r.reporter),
      `<div class="font-medium">${who(r.target)}${r.target && r.target.banned ? ' <span class="text-red-600 text-xs">(已停權)</span>' : ''}</div><div class="text-[11px] text-slate-400">被檢舉共 ${counts[r.target_user_id]} 次</div>`,
      r.book ? esc(r.book.title) + ' <span class="text-xs text-slate-400">(' + (BOOK_STATUS[r.book.status] || r.book.status) + ')</span>' : '—',
      esc(REASON[r.reason] || r.reason),
      `<span class="text-xs whitespace-pre-wrap break-words max-w-xs inline-block">${esc(r.detail || '—')}</span>`,
      actions
        ? `<div class="flex gap-1 flex-wrap">${r.book && r.book.status !== 'hidden' ? btn(`data-rp="takedown" data-id="${r.id}"`, '強制下架這本書', 'border-red-300 text-red-600') : ''}${r.target && !r.target.banned ? btn(`data-rp="ban" data-id="${r.id}"`, '強制剔除這位使用者', 'border-red-300 text-red-600') : ''}${btn(`data-rp="dismiss" data-id="${r.id}"`, '駁回')}</div>`
        : esc(r.status === 'actioned' ? '已處理' : '已駁回') + (r.handled_note ? ':' + esc(r.handled_note) : '')
    ];
    const open = rows.filter((r) => r.status === 'open');
    const done = rows.filter((r) => r.status !== 'open');
    return `<h2 class="font-bold mb-2">待處理(${open.length})</h2>` +
      table(['時間', '檢舉人', '被檢舉者', '書', '原因', '說明', '操作'], open.map((r) => line(r, true))) +
      `<h2 class="font-bold mt-6 mb-2">已處理</h2>` +
      table(['時間', '檢舉人', '被檢舉者', '書', '原因', '說明', '結果'], done.map((r) => line(r, false)));
  }

  // ---------- 交易地點 ----------
  async function viewPlaces() {
    const rows = unwrap(await sb.from('meetup_places').select('id,name,sort,active').order('sort').order('id'));
    const form = `<form id="form-place" class="flex gap-2 mb-4 max-w-lg"><input name="name" required maxlength="40" placeholder="新增面交地點,例:圖書館一樓門口" class="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"><button class="rounded-lg bg-blue-500 text-white font-semibold px-5 py-2 text-sm whitespace-nowrap">新增</button></form>`;
    viewPlaces.max = rows.reduce((m, r) => Math.max(m, r.sort), 0);
    return '<p class="text-xs text-slate-500 mb-2">同學上架書籍與約定面交時,地點只能從這份清單選擇。停用後不會出現在選單,已上架的書不受影響。</p>' + form +
      table(['地點', '狀態', '操作'], rows.map((r) => [esc(r.name), r.active ? '使用中' : '已停用',
        `<div class="flex gap-1">${btn(`data-place-toggle="${r.id}" data-active="${r.active ? 0 : 1}"`, r.active ? '停用' : '啟用')}${btn(`data-place-del="${r.id}"`, '刪除', 'border-red-300 text-red-600')}</div>`]));
  }

  async function viewLogins() {
    const rows = unwrap(await sb.from('login_logs').select('id,ip,user_agent,created_at,user:profiles(display_name)')
      .order('created_at', { ascending: false }).limit(300));
    return '<p class="text-xs text-slate-500 mb-2">顯示最近 300 筆登入紀錄</p>' +
      table(['時間', '使用者', 'IP', '裝置'], rows.map((r) => [fmt(r.created_at), who(r.user), esc(r.ip), `<span class="text-xs text-slate-500">${esc(r.user_agent)}</span>`]));
  }

  async function viewBooks() {
    const rows = unwrap(await sb.from('books').select('id,title,teacher,course_dept,price,status,allow_meetup,allow_shipping,created_at,seller:profiles!seller_id(display_name)')
      .order('created_at', { ascending: false }).limit(500));
    return table(['上架時間', '書名', '老師 / 開課系所', '賣家', '價格', '交易方式', '狀態', '操作'], rows.map((b) => [
      fmt(b.created_at), esc(b.title), esc([b.teacher, b.course_dept].filter(Boolean).join(' / ')), who(b.seller), 'NT$ ' + esc(b.price),
      [b.allow_meetup ? '面交' : '', b.allow_shipping ? '寄送' : ''].filter(Boolean).join('、'),
      BOOK_STATUS[b.status] || b.status,
      `<div class="flex gap-1">${b.status === 'hidden' ? btn(`data-book="active" data-id="${esc(b.id)}"`, '恢復上架') : btn(`data-book="hidden" data-id="${esc(b.id)}"`, '下架')}
       ${btn(`data-book-del="${esc(b.id)}"`, '刪除', 'border-red-300 text-red-600')}</div>`
    ]));
  }

  async function viewWishes() {
    const rows = unwrap(await sb.from('wishes').select('id,title,course,budget,status,created_at,user:profiles!user_id(display_name)')
      .order('created_at', { ascending: false }).limit(500));
    const st = { active: '許願中', fulfilled: '已達成', hidden: '已隱藏' };
    return table(['時間', '書名', '許願者', '課程', '預算', '狀態', '操作'], rows.map((w) => [
      fmt(w.created_at), esc(w.title), who(w.user), esc(w.course), w.budget != null ? 'NT$ ' + esc(w.budget) : '—', st[w.status] || w.status,
      `<div class="flex gap-1">${w.status === 'hidden' ? btn(`data-wish="active" data-id="${esc(w.id)}"`, '恢復') : btn(`data-wish="hidden" data-id="${esc(w.id)}"`, '隱藏')}
       ${btn(`data-wish-del="${esc(w.id)}"`, '刪除', 'border-red-300 text-red-600')}</div>`
    ]));
  }

  async function viewThreads() {
    threadCache = unwrap(await sb.from('threads').select(
      '*, book:books(title,price), wish:wishes(title), buyer:profiles!buyer_id(display_name), seller:profiles!seller_id(display_name)')
      .order('updated_at', { ascending: false }).limit(500));
    return table(['最後活動', '類型', '書 / 願望', '買家', '賣家', '方式', '狀態', '操作'], threadCache.map((t) => [
      fmt(t.updated_at), t.book_id || t.book ? '買書' : '願望回應',
      esc(t.book ? t.book.title + '(NT$ ' + t.book.price + ')' : (t.wish ? t.wish.title : '(已刪除)')),
      who(t.buyer), who(t.seller), METHOD[t.method] || '—', THREAD_STATUS[t.status],
      btn(`data-thread="${esc(t.id)}"`, '查看聊天')
    ]));
  }

  // ---------- 廣播 / 公告 ----------
  async function viewBroadcast() {
    const rows = unwrap(await sb.from('announcements').select('*').order('created_at', { ascending: false }).limit(50));
    const sum = (r) => {
      const x = r.result || {};
      const parts = [];
      if (x.push) parts.push('推播 ' + x.push.sent + ' 則' + (x.push.failed ? '(失敗 ' + x.push.failed + ')' : ''));
      if (x.email) parts.push('Email ' + x.email.sent + ' 封' + (x.email.failed ? '(失敗 ' + x.email.failed + ')' : ''));
      if (x.line) parts.push('LINE ' + (x.line.ok ? '已廣播' : '失敗:' + esc(x.line.error || '')));
      return parts.join('、') || '—';
    };
    const form = `<form id="form-bc" class="bg-white border border-slate-200 rounded-xl p-4 space-y-3 mb-5 max-w-2xl">
      <h2 class="font-bold">發送新公告 / 廣播</h2>
      <input name="title" required maxlength="100" placeholder="標題" class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm">
      <textarea name="body" required maxlength="2000" rows="4" placeholder="內容(最多 2000 字)" class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"></textarea>
      <input name="link" maxlength="500" placeholder="連結(選填,https://…)" class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm">
      <label class="block text-xs text-slate-500">站內公告到期時間(選填,過期自動消失)
        <input name="expires" type="datetime-local" class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"></label>
      <fieldset class="space-y-1.5 text-sm"><legend class="text-xs text-slate-500 mb-1">發送管道</legend>
        <label class="flex gap-2"><input type="checkbox" checked disabled> 📢 站內公告(網站最上方橫幅,所有人看得到,免費)</label>
        <label class="flex gap-2"><input type="checkbox" name="push"> 🔔 瀏覽器推播(已開啟推播的使用者,免費)</label>
        <label class="flex gap-2"><input type="checkbox" name="email"> ✉️ Email(已開啟 Email 通知的使用者;Brevo 免費方案每日 300 封)</label>
        <label class="flex gap-2"><input type="checkbox" name="line"> 💬 LINE 官方帳號廣播(發給官方帳號所有好友,<b class="text-red-600">會耗用 LINE 訊息額度</b>)</label>
      </fieldset>
      <button class="rounded-lg bg-blue-500 text-white font-semibold px-5 py-2 text-sm">發送</button>
      <p id="bc-result" class="text-sm"></p></form>`;
    const list = table(['時間', '標題', '管道', '結果', '狀態', '操作'], rows.map((r) => [
      fmt(r.created_at), `<div class="font-medium">${esc(r.title)}</div><div class="text-xs text-slate-500 max-w-xs whitespace-pre-wrap break-words">${esc(r.body.slice(0, 120))}</div>`,
      esc((r.channels || []).join('、')), sum(r), r.active ? '顯示中' : '已停用',
      `<div class="flex gap-1">${btn(`data-ann-toggle="${esc(r.id)}" data-active="${r.active ? 0 : 1}"`, r.active ? '停用' : '啟用')}${btn(`data-ann-del="${esc(r.id)}"`, '刪除', 'border-red-300 text-red-600')}</div>`
    ]));
    return form + '<h2 class="font-bold mb-2">歷史公告</h2>' + list;
  }

  // ---------- 同意書 ----------
  async function viewConsent() {
    const v = unwrap(await sb.from('app_settings').select('value').eq('key', 'terms_version').maybeSingle());
    const cur = v ? v.value : '(未設定)';
    const local = window.TERMS ? window.TERMS.version : '';
    const [users, signed] = await Promise.all([count('profiles'), count('consents', (q) => q.eq('version', cur))]);
    const rows = unwrap(await sb.from('consents').select('id,version,ip,user_agent,signed_at,user:profiles(display_name)')
      .order('signed_at', { ascending: false }).limit(500));
    const warn = cur !== local ? `<p class="text-sm text-red-600 mb-2">⚠️ 資料庫版本(${esc(cur)})與 terms.js 版本(${esc(local)})不同,使用者將無法簽署成功。請讓兩者一致。</p>` : '';
    return `<div class="bg-white border border-slate-200 rounded-xl p-4 mb-5 max-w-2xl space-y-2">
        <h2 class="font-bold">目前生效的同意書版本</h2>
        <p class="text-sm">資料庫版本:<b>${esc(cur)}</b>　|　網站 terms.js 版本:<b>${esc(local)}</b></p>${warn}
        <p class="text-sm">已簽署目前版本:<b>${signed}</b> / ${users} 位使用者</p>
        <form id="form-ver" class="flex gap-2 pt-1"><input name="version" required maxlength="60" placeholder="新版本字串,例如 2026-12-01-v2" class="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm">
          <button class="rounded-lg bg-slate-800 text-white px-4 py-2 text-sm whitespace-nowrap">更新版本(全員需重簽)</button></form>
        <p class="text-xs text-slate-500">流程:① 修改 terms.js 並把裡面的 version 改成新字串並重新部署網站 → ② 在這裡輸入「相同」的新版本字串。所有使用者下次進站就必須重新閱讀並簽署。</p>
      </div>
      <h2 class="font-bold mb-2">簽署紀錄</h2>` +
      table(['同意時間', '使用者', '版本', 'IP', '裝置'], rows.map((r) => [
        fmt(r.signed_at), who(r.user), esc(r.version), esc(r.ip), `<span class="text-xs text-slate-500">${esc(r.user_agent)}</span>`]));
  }

  async function viewModeration() {
    const rows = unwrap(await sb.from('moderation_log').select('id,target_title,target_id,action,reason,created_at,admin:profiles!admin_id(display_name)')
      .order('created_at', { ascending: false }).limit(300));
    const ACT = { hide: '下架', restore: '恢復上架', ban: '停權', unban: '解除停權', verify: '核准為在校生', unverify: '取消驗證', reject_verify: '退回學生證', reset_password: '重設密碼', dispute_update: '處理交易爭議', role_change: '調整管理員權限', test_account: '切換測試帳號' };
    return '<p class="text-xs text-slate-500 mb-2">管理員下架書籍、停權使用者等處置紀錄(保留作為處理檢舉與糾紛的依據)</p>' +
      table(['時間', '管理員', '動作', '對象(書名 / 使用者)', '原因'], rows.map((r) => [
        fmt(r.created_at), who(r.admin), ACT[r.action] || esc(r.action), esc(r.target_title), esc(r.reason || '—')]));
  }

  // ---------- 營運統計 ----------
  async function viewStats() {
    const s = unwrap(await sb.rpc('admin_stats'));
    const card = (label, v, sub) => `<div class="bg-white rounded-xl border border-slate-200 p-4"><div class="text-xs text-slate-500">${label}</div><div class="text-2xl font-bold">${v}</div>${sub ? `<div class="text-[11px] text-slate-400">${sub}</div>` : ''}</div>`;
    const bars = (rows) => {
      rows = rows || [];
      const max = Math.max(1, ...rows.map((r) => Number(r.cnt)));
      return rows.length ? rows.map((r) => `<div class="flex items-center gap-2 text-xs mb-1.5"><div class="w-32 truncate" title="${esc(r.name)}">${esc(r.name)}</div><div class="flex-1 rounded h-4" style="background:#eee5e0"><div class="h-4 rounded" style="width:${Math.round(Number(r.cnt) / max * 100)}%;background:var(--brand)"></div></div><div class="w-8 text-right">${esc(r.cnt)}</div></div>`).join('') : '<p class="text-xs text-slate-400">還沒有資料</p>';
    };
    const box = (title, inner, note) => `<div class="bg-white rounded-xl border border-slate-200 p-4"><h3 class="font-bold text-sm mb-2">${title}</h3>${note ? `<p class="text-[11px] text-slate-400 mb-2">${note}</p>` : ''}${inner}</div>`;
    const rate = s.threads ? Math.round(s.deals / s.threads * 100) + '%' : '—';
    const months = (s.by_month || []);
    const maxM = Math.max(1, ...months.map((m) => Math.max(m.users, m.books, m.deals)));
    const monthRows = months.map((m) => `<tr><td class="py-1 pr-3 text-xs">${esc(m.m)}</td>${[['users', '#6f97b2'], ['books', '#d9b98a'], ['deals', '#82ad97']].map(([k, c]) => `<td class="py-1 pr-2"><div class="flex items-center gap-1"><div class="h-3 rounded" style="width:${Math.max(2, Math.round(m[k] / maxM * 80))}px;background:${c}"></div><span class="text-xs">${esc(m[k])}</span></div></td>`).join('')}</tr>`).join('');
    return `<div class="grid grid-cols-2 md:grid-cols-4 gap-3">
      ${card('註冊使用者', s.users, '已認證 ' + s.verified + ' 人')}${card('上架中的書', s.books_active, '累計上架 ' + s.books_total + ' 本')}
      ${card('成交率', rate, '完成 ' + s.deals + ' / 洽談 ' + s.threads + ' 筆')}${card('收藏次數', s.favorites, '許願中 ' + s.wishes_active + ' 筆')}</div>
      <div class="grid md:grid-cols-2 gap-3 mt-3">
        ${box('每月趨勢(近 6 個月)', `<table><thead><tr class="text-[11px] text-slate-400"><th class="text-left font-normal">月份</th><th class="text-left font-normal">新增使用者</th><th class="text-left font-normal">上架書籍</th><th class="text-left font-normal">完成交易</th></tr></thead><tbody>${monthRows}</tbody></table>`)}
        ${box('各系所教材數量', bars(s.dept_books), '依書籍的開課系所統計')}
        ${box('熱門課程', bars(s.top_courses))}
        ${box('熱門老師', bars(s.top_teachers))}
        ${box('最多人收藏的書', bars(s.top_favorited))}
        ${box('許願最多的書(教材需求)', bars(s.top_wishes))}
        ${box('熱門搜尋(近 60 天)', bars(s.top_searches), '只記錄關鍵字,不記錄是誰搜的')}
        ${box('搜尋不到的書(近 60 天)', bars(s.zero_searches), '同學找過但目前沒有的書,可以鼓勵大家上架')}
      </div>`;
  }

  // ---------- 管理員權限 ----------
  const ROLE_LABEL = { super: '最高權限', moderator: '一般管理員', viewer: '唯讀' };
  async function viewAdmins() {
    const list = unwrap(await sb.rpc('admin_list_admins')) || [];
    const ids = new Set(list.map((a) => a.user_id));
    const users = unwrap(await sb.from('profiles').select('id,display_name').order('created_at', { ascending: false }).limit(500)).filter((u) => !ids.has(u.id));
    const canEdit = myRole === 'super';
    const sel = (cur, id) => `<select data-role-sel="${esc(id)}" class="rounded border border-slate-300 px-2 py-1 text-xs" ${canEdit ? '' : 'disabled'}>${['super', 'moderator', 'viewer'].map((r) => `<option value="${r}" ${r === cur ? 'selected' : ''}>${ROLE_LABEL[r]}</option>`).join('')}</select>`;
    return `<div class="bg-white rounded-xl border border-slate-200 p-4 mb-3 text-xs text-slate-600 leading-6">
        <b>三種角色</b><br>• <b>最高權限</b>:所有功能,包含重設密碼、測試帳號、調整管理員權限<br>• <b>一般管理員</b>:審核學生證、處理檢舉、下架與停權、公告與交易地點;不能重設密碼或調整權限<br>• <b>唯讀</b>:只能看資料與統計,不能做任何處置<br>所有權限變更與敏感操作都會寫進「處置紀錄」。${canEdit ? '' : '<br><span class="text-red-600">你的角色是「' + esc(ROLE_LABEL[myRole] || myRole) + '」,只有最高權限可以調整。</span>'}</div>` +
      table(['管理員', '角色', '操作'], list.map((a) => [esc(a.display_name || a.user_id), sel(a.role, a.user_id), canEdit ? `<div class="flex gap-1">${btn(`data-role-save="${esc(a.user_id)}"`, '儲存')}${btn(`data-role-remove="${esc(a.user_id)}"`, '移除管理員', 'border-red-300 text-red-600')}</div>` : '—'])) +
      (canEdit ? `<div class="bg-white rounded-xl border border-slate-200 p-4 mt-3"><h3 class="font-bold text-sm mb-2">新增管理員</h3><div class="flex flex-wrap gap-2">
        <select id="new-admin-user" class="rounded border border-slate-300 px-2 py-1 text-sm max-w-full">${users.map((u) => `<option value="${esc(u.id)}">${esc(u.display_name)}</option>`).join('')}</select>
        <select id="new-admin-role" class="rounded border border-slate-300 px-2 py-1 text-sm"><option value="viewer">唯讀</option><option value="moderator">一般管理員</option><option value="super">最高權限</option></select>
        ${btn('id="btn-add-admin"', '新增', 'border-blue-500')}</div><p class="text-[11px] text-slate-400 mt-2">新增的管理員要用「Email + 密碼」登入後台,請先請對方在前台完成認證並設定登入帳號。</p></div>` : '');
  }

  // ---------- 交易爭議 ----------
  const DISPUTE_REASON = { no_show: '對方沒出現 / 沒回應', condition: '書況與描述不符', price: '價格或運費爭議', harassment: '騷擾或不當言論', other: '其他' };
  const DISPUTE_STATUS = { open: '<span class="text-red-600">待處理</span>', investigating: '<span class="text-amber-600">處理中</span>', resolved: '<span class="text-emerald-700">已解決</span>', dismissed: '<span class="text-slate-500">已結案</span>' };
  async function viewDisputes() {
    const rows = unwrap(await sb.from('transaction_disputes').select(
      '*, reporter:profiles!reporter_id(display_name), thread:threads(id, book:books(title), buyer:profiles!buyer_id(display_name), seller:profiles!seller_id(display_name))')
      .order('created_at', { ascending: false }).limit(300)) || [];
    return '<p class="text-xs text-slate-500 mb-2">同學在聊天室按「交易爭議」送來的案件。處理時填的說明會通知送出的同學,並寫進處置紀錄。要看雙方對話,請到「交易 / 聊聊」分頁。</p>' +
      table(['時間', '送出者', '買家 / 賣家', '書', '類型', '說明', '狀態', '管理員說明', '操作'], rows.map((d) => [
        fmt(d.created_at), who(d.reporter),
        d.thread ? who(d.thread.buyer) + ' / ' + who(d.thread.seller) : '—', esc(d.thread && d.thread.book ? d.thread.book.title : '(書已刪除)'),
        esc(DISPUTE_REASON[d.reason] || d.reason), `<div class="max-w-[14rem] break-words text-xs">${esc(d.detail || '—')}</div>`,
        DISPUTE_STATUS[d.status] || esc(d.status), `<div class="max-w-[12rem] break-words text-xs">${esc(d.admin_note || '—')}</div>`,
        d.status === 'resolved' || d.status === 'dismissed' ? '—' : `<div class="flex flex-col gap-1">${d.status === 'open' ? btn(`data-dp="investigating" data-id="${esc(d.id)}"`, '開始處理') : ''}${btn(`data-dp="resolved" data-id="${esc(d.id)}"`, '標為已解決', 'border-emerald-400')}${btn(`data-dp="dismissed" data-id="${esc(d.id)}"`, '結案(不成立)')}</div>`
      ]));
  }

  // ---------- 學期與課程教材 ----------
  let semSel = null;
  async function viewTextbooks() {
    const sems = unwrap(await sb.from('semesters').select('*').order('start_date', { ascending: false })) || [];
    let cur = semSel;
    if (!cur || !sems.find((s) => s.id === cur)) { const r = await sb.rpc('current_semester'); cur = r.data || (sems[0] && sems[0].id) || null; }
    semSel = cur;
    const autoCur = (await sb.rpc('current_semester')).data;
    const courses = cur ? (unwrap(await sb.from('courses').select('*, course_textbooks(*)').eq('semester_id', cur).order('dept').order('name')) || []) : [];
    const inp = 'class="rounded border border-slate-300 px-2 py-1 text-sm"';
    const semTable = sems.length ? table(['學期', '期間', '狀態', '操作'], sems.map((s) => [
      `<b>${esc(s.name)}</b>${s.id === cur ? ' <span class="text-blue-600 text-xs">(正在編輯)</span>' : ''}`, esc(s.start_date + ' ~ ' + s.end_date),
      s.id === autoCur ? '<span class="text-emerald-700 text-xs">本學期(依日期自動切換)</span>' : '—',
      `<div class="flex gap-1">${btn(`data-sem-pick="${esc(s.id)}"`, '編輯課程教材')}${btn(`data-sem-del="${esc(s.id)}"`, '刪除', 'border-red-300 text-red-600')}</div>`])) : '<p class="text-sm text-slate-500 mb-2">還沒有學期,先在下面新增一個。</p>';
    const deptOpts = (window.DEPARTMENTS || []).map((d) => `<option>${esc(d)}</option>`).join('');
    const courseCards = courses.map((c) => `<div class="bg-white rounded-xl border border-slate-200 p-3 mb-2">
        <div class="flex items-start justify-between gap-2"><div><b>${esc(c.name)}</b> <span class="text-xs text-slate-500">${esc(c.dept)}${c.teacher ? ' · ' + esc(c.teacher) : ''}</span></div>${btn(`data-course-del="${esc(c.id)}"`, '刪除課程', 'border-red-300 text-red-600')}</div>
        <div class="mt-1 space-y-1">${(c.course_textbooks || []).map((t) => `<div class="flex items-center justify-between text-sm"><span>📘 ${esc(t.title)} ${t.isbn ? `<span class="text-xs text-slate-400">ISBN ${esc(t.isbn)}</span>` : ''} <span class="text-xs ${t.required ? 'text-amber-600' : 'text-slate-400'}">${t.required ? '必備' : '參考'}</span></span>${btn(`data-tb-del="${esc(t.id)}"`, '刪除')}</div>`).join('') || '<div class="text-xs text-slate-400">還沒有教材</div>'}</div>
        <div class="flex flex-wrap gap-1 mt-2"><input id="tb-title-${esc(c.id)}" ${inp} placeholder="教材書名"><input id="tb-isbn-${esc(c.id)}" ${inp} placeholder="ISBN(選填)" style="width:9rem">${btn(`data-add-tb="${esc(c.id)}"`, '新增教材', 'border-blue-500')}</div></div>`).join('');
    return `<div class="bg-white rounded-xl border border-slate-200 p-4 mb-3"><h3 class="font-bold text-sm mb-2">學期</h3>${semTable}
      <div class="flex flex-wrap gap-2 mt-3"><input id="sem-name" ${inp} placeholder="學期,例:114-2" style="width:8rem"><input id="sem-start" type="date" ${inp}><input id="sem-end" type="date" ${inp}>${btn('id="btn-add-sem"', '新增學期', 'border-blue-500')}</div>
      <p class="text-[11px] text-slate-400 mt-2">同學打開「教材專區」時,會自動顯示「今天落在哪個學期」的課程教材,不需要手動切換。</p></div>` +
      (cur ? `<div class="bg-white rounded-xl border border-slate-200 p-4 mb-3"><h3 class="font-bold text-sm mb-1">批次匯入課程與教材(目前學期:${esc((sems.find((s) => s.id === cur) || {}).name)})</h3>
        <p class="text-xs text-slate-500 mb-2">一行一本教材,用逗號或 Tab 分隔:<code>系所,課程,老師,教材書名,ISBN,必備或參考</code>(老師、ISBN、必備可留空)。例:<br><code>護理系,基礎護理學,王老師,基礎護理學(第十版),9789571111111,必備</code></p>
        <textarea id="imp-text" rows="6" class="w-full rounded border border-slate-300 px-2 py-1 text-sm font-mono" placeholder="護理系,基礎護理學,王老師,基礎護理學,,必備"></textarea>
        <div class="mt-2">${btn('id="btn-import"', '匯入', 'border-blue-500')}</div></div>
        <div class="bg-white rounded-xl border border-slate-200 p-4 mb-3"><h3 class="font-bold text-sm mb-2">新增單一課程</h3><div class="flex flex-wrap gap-2">
          <select id="course-dept" ${inp}>${deptOpts}</select><input id="course-name" ${inp} placeholder="課程名稱"><input id="course-teacher" ${inp} placeholder="老師(選填)">${btn('id="btn-add-course"', '新增課程', 'border-blue-500')}</div></div>
        <h3 class="font-bold text-sm mb-2">這個學期的課程(${courses.length})</h3>${courseCards || '<p class="text-sm text-slate-500">還沒有課程</p>'}` : '');
  }

  const VIEWS = { disputes: viewDisputes, textbooks: viewTextbooks, stats: viewStats, admins: viewAdmins, verify: viewVerify, reports: viewReports, places: viewPlaces, moderation: viewModeration, broadcast: viewBroadcast, consent: viewConsent, overview: viewOverview, users: viewUsers, logins: viewLogins, books: viewBooks, wishes: viewWishes, threads: viewThreads };

  async function render() {
    $('tabs').innerHTML = TABS.map((t) => `<button data-tab="${t[0]}" class="px-4 py-2 text-sm font-semibold border-b-2 whitespace-nowrap ${t[0] === tab ? 'border-blue-500 text-blue-600' : 'border-transparent text-slate-500'}">${t[1]}</button>`).join('');
    $('panel').innerHTML = '<p class="py-10 text-center text-slate-400">載入中…</p>';
    try { $('panel').innerHTML = await VIEWS[tab](); }
    catch (e) { console.error(e); $('panel').innerHTML = `<p class="py-10 text-center text-red-600">載入失敗:${esc(e.message)}</p>`; }
  }

  // ---------- 聊天內容 ----------
  async function openChat(id) {
    const t = threadCache.find((x) => x.id === id);
    if (!t) return;
    const msgs = unwrap(await sb.from('messages').select('*').eq('thread_id', id).order('id', { ascending: true }).limit(1000));
    const name = (uid) => (uid === t.buyer_id ? '買家 ' + ((t.buyer || {}).display_name || '') : '賣家 ' + ((t.seller || {}).display_name || ''));
    $('chat-title').textContent = t.book ? t.book.title : (t.wish ? '🙏 ' + t.wish.title : '聊聊');
    $('chat-sub').textContent = `買家 ${(t.buyer || {}).display_name || ''} ↔ 賣家 ${(t.seller || {}).display_name || ''} · ${METHOD[t.method] || '—'} · ${THREAD_STATUS[t.status]}`;
    $('chat-msgs').innerHTML = msgs.map((m) => m.is_system
      ? `<div class="text-center text-xs text-slate-500">${esc(m.body)} <span class="text-slate-400">${fmt(m.created_at)}</span></div>`
      : `<div><div class="text-[11px] text-slate-500">${esc(name(m.sender_id))} · ${fmt(m.created_at)}</div>
         <div class="inline-block rounded-2xl bg-white border border-slate-200 px-3 py-2 text-sm whitespace-pre-wrap break-words max-w-full">${esc(m.body)}</div></div>`).join('') ||
      '<p class="text-center text-sm text-slate-400">沒有訊息</p>';
    const canCancel = t.status === 'open' || t.status === 'accepted';
    $('chat-actions').innerHTML = canCancel ? btn(`data-admin-cancel="${esc(t.id)}"`, '管理員取消這筆交易', 'border-red-300 text-red-600') : '';
    $('modal-chat').classList.remove('hidden');
  }

  // ---------- 事件 ----------
  $('chat-close').addEventListener('click', () => $('modal-chat').classList.add('hidden'));
  $('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) { tab = b.dataset.tab; render(); }
  });

  async function act(fn, okMsg) {
    try { await fn(); if (okMsg) toast(okMsg); await render(); }
    catch (e) { toast(e.message || '操作失敗'); }
  }

  document.addEventListener('click', (e) => {
    const g = (sel) => e.target.closest(sel);
    let el;
    if ((el = g('#btn-logout'))) {
      sb.auth.signOut().then(() => location.reload());
    } else if ((el = g('[data-ban]'))) {
      const ban = el.dataset.ban === '1';
      let reason = '';
      if (ban) {
        reason = prompt('強制剔除(停權)這位使用者?\n他的上架書籍會被下架、進行中的交易會取消,並且立刻被強制登出。\n請填寫原因(會顯示給對方看)。按「取消」可中止。', '');
        if (reason === null) return;
      }
      act(async () => unwrap(await sb.rpc('admin_set_ban', { p_user: el.dataset.id, p_ban: ban, p_reason: reason })), ban ? '已停權' : '已解除停權');
    } else if ((el = g('[data-revoke]'))) {
      const note = prompt('取消這位同學的學校認證?\n他會無法買書、賣書、聊聊,直到重新認證。\n請填寫原因(會顯示給同學看)。按「取消」可中止。', '');
      if (note === null) return;
      act(async () => unwrap(await sb.rpc('admin_revoke_verify', { p_user: el.dataset.id, p_note: note })), '已取消認證');
    } else if ((el = g('[data-pwreset]'))) {
      if (!confirm('重設這位同學的密碼?會產生一組臨時密碼(只顯示一次),請用 LINE 或當面告訴他,並請他登入後自己改。')) return;
      (async () => {
        try { const pw = unwrap(await sb.rpc('admin_reset_password', { p_user: el.dataset.id })); prompt('臨時密碼(請複製後告訴同學,關閉後就看不到了):', pw); toast('已重設密碼'); }
        catch (e) { toast(e.message || '操作失敗'); }
      })();
    } else if ((el = g('#btn-test-account'))) {
      if (!confirm('切換成「測試同學」?\n你會用一般同學的身分打開前台(已認證、可買賣聊聊),方便測試。\n要回後台時請重新用管理員帳號登入。')) return;
      (async () => {
        try {
          const a = unwrap(await sb.rpc('admin_prepare_test_account'))[0];
          const r = await sb.auth.signInWithPassword({ email: a.email, password: a.password });
          if (r.error) throw r.error;
          try { localStorage.setItem('cb_login_at', String(Date.now())); } catch (e2) { /* ignore */ }
          location.href = './';
        } catch (e) { toast(e.message || '無法切換'); }
      })();
    } else if ((el = g('[data-verify]'))) {
      const ok = el.dataset.verify === '1';
      if (confirm(ok ? '手動核准這位使用者為在校生?(沒有學校信箱的同學可用)' : '取消這位使用者的在校生驗證?他將無法使用,直到重新驗證。')) {
        act(async () => unwrap(await sb.rpc('admin_set_verified', { p_user: el.dataset.id, p_ok: ok })), ok ? '已核准' : '已取消驗證');
      }
    } else if ((el = g('[data-vr]'))) {
      const ok = el.dataset.vr === '1';
      let note = '';
      if (ok) { if (!confirm('確認學號與學生證相符,通過這位同學?')) return; }
      else { note = prompt('退回這份申請?\n請填寫退回原因(會顯示給同學看,例如:照片不清楚、學號與學生證不符)。按「取消」可中止。', ''); if (note === null) return; }
      act(async () => {
        const path = unwrap(await sb.rpc('admin_review_student', { p_user: el.dataset.id, p_ok: ok, p_note: note }));
        if (path) await sb.storage.from('student-cards').remove([path]);   // 審核完立即刪除學生證照片
      }, ok ? '已通過,學生證照片已刪除' : '已退回,學生證照片已刪除');
    } else if ((el = g('[data-rp]'))) {
      const action = el.dataset.rp;
      const label = { takedown: '強制下架這本書', ban: '強制剔除這位使用者(停權)', dismiss: '駁回這筆檢舉' }[action];
      const note = prompt(label + '?\n可填寫處理說明(會成為下架 / 停權原因)。按「取消」可中止。', '');
      if (note === null) return;
      act(async () => unwrap(await sb.rpc('resolve_report', { p_report: Number(el.dataset.id), p_action: action, p_note: note })), '已處理');
    } else if ((el = g('[data-place-toggle]'))) {
      act(async () => unwrap(await sb.from('meetup_places').update({ active: el.dataset.active === '1' }).eq('id', el.dataset.placeToggle)), '已更新');
    } else if ((el = g('[data-place-del]'))) {
      if (confirm('刪除這個地點?(已上架的書不受影響)')) act(async () => unwrap(await sb.from('meetup_places').delete().eq('id', el.dataset.placeDel)), '已刪除');
    } else if ((el = g('[data-book]'))) {
      const hide = el.dataset.book === 'hidden';
      let reason = '';
      if (hide) {
        reason = prompt('下架這本書?\n可填寫原因(選填,會通知進行中的買家並取消相關交易)。按「取消」可中止。', '');
        if (reason === null) return;
      }
      act(async () => unwrap(await sb.rpc('admin_set_book_hidden', { p_book: el.dataset.id, p_hidden: hide, p_reason: reason })), hide ? '已下架' : '已恢復上架');
    } else if ((el = g('[data-book-del]'))) {
      if (confirm('永久刪除這本書?(相關交易會保留但失去書籍連結)')) act(async () => unwrap(await sb.from('books').delete().eq('id', el.dataset.bookDel)), '已刪除');
    } else if ((el = g('[data-wish]'))) {
      act(async () => unwrap(await sb.from('wishes').update({ status: el.dataset.wish }).eq('id', el.dataset.id)), '已更新');
    } else if ((el = g('[data-wish-del]'))) {
      if (confirm('永久刪除這個願望?')) act(async () => unwrap(await sb.from('wishes').delete().eq('id', el.dataset.wishDel)), '已刪除');
    } else if ((el = g('[data-thread]'))) {
      openChat(el.dataset.thread).catch((ex) => toast(ex.message));
    } else if ((el = g('[data-admin-cancel]'))) {
      if (confirm('確定以管理員身分取消這筆交易?')) {
        act(async () => { unwrap(await sb.rpc('set_thread_status', { p_thread: el.dataset.adminCancel, p_status: 'cancelled' })); $('modal-chat').classList.add('hidden'); }, '已取消');
      }
    }
  });

  // 廣播:建立公告並呼叫 broadcast 函式送出
  document.addEventListener('submit', async (e) => {
    if (e.target.id === 'form-login') {
      e.preventDefault();
      const f = e.target.elements, out = $('login-error');
      out.classList.add('hidden');
      try {
        const { error } = await sb.auth.signInWithPassword({ email: f.email.value.trim(), password: f.password.value });
        if (error) throw error;
        await sb.rpc('log_my_login');
        location.reload();
      } catch (ex) { out.textContent = '登入失敗:帳號或密碼不正確'; out.classList.remove('hidden'); }
      return;
    }
    if (e.target.id === 'form-place') {
      e.preventDefault();
      const name = e.target.elements.name.value.trim();
      act(async () => unwrap(await sb.from('meetup_places').insert({ name, sort: (viewPlaces.max || 0) + 1 })), '已新增');
      return;
    }
    if (e.target.id === 'form-bc') {
      e.preventDefault();
      const f = e.target.elements;
      const ch = ['push', 'email', 'line'].filter((k) => f[k].checked);
      const names = { push: '瀏覽器推播', email: 'Email', line: 'LINE 官方帳號廣播(耗額度)' };
      const msg = '確定發送?\n\n管道:站內公告' + ch.map((k) => '、' + names[k]).join('') + '\n標題:' + f.title.value.trim();
      if (!confirm(msg)) return;
      const out = $('bc-result');
      out.className = 'text-sm text-slate-600'; out.textContent = '發送中…';
      try {
        const row = unwrap(await sb.from('announcements').insert({
          title: f.title.value.trim(), body: f.body.value.trim(), link: f.link.value.trim(),
          channels: ['site'].concat(ch), expires_at: f.expires.value ? new Date(f.expires.value).toISOString() : null, created_by: me.id
        }).select('id').single());
        let result = {};
        if (ch.length) {
          const r = await sb.functions.invoke(window.APP_CONFIG.FN_BROADCAST || 'broadcast', { body: { announcement_id: row.id, channels: ch } });
          if (r.error) {
            let m = r.error.message; try { m = (await r.error.context.json()).error || m; } catch (x) { /* ignore */ }
            throw new Error('公告已建立,但廣播失敗:' + m);
          }
          result = r.data || {};
        }
        out.className = 'text-sm text-emerald-700';
        out.textContent = '✅ 已發送。' + (result.push ? ' 推播 ' + result.push.sent + ' 則。' : '') + (result.email ? ' Email ' + result.email.sent + ' 封。' : '') + (result.line ? (result.line.ok ? ' LINE 已廣播。' : ' LINE 失敗:' + (result.line.error || '')) : '');
        e.target.reset();
        setTimeout(render, 1200);
      } catch (ex) { out.className = 'text-sm text-red-600'; out.textContent = ex.message || '發送失敗'; }
    } else if (e.target.id === 'form-ver') {
      e.preventDefault();
      const v = e.target.elements.version.value.trim();
      if (!confirm('確定把同意書版本更新為「' + v + '」?\n所有使用者下次進站都必須重新簽署。\n請先確認 terms.js 已改成相同版本並重新部署。')) return;
      act(async () => unwrap(await sb.rpc('set_terms_version', { p_version: v })), '已更新同意書版本');
    }
  });

  document.addEventListener('click', (e) => {
    let el;
    if ((el = e.target.closest('[data-ann-toggle]'))) {
      act(async () => unwrap(await sb.from('announcements').update({ active: el.dataset.active === '1' }).eq('id', el.dataset.annToggle)), '已更新');
    } else if ((el = e.target.closest('[data-ann-del]'))) {
      if (confirm('刪除這則公告?')) act(async () => unwrap(await sb.from('announcements').delete().eq('id', el.dataset.annDel)), '已刪除');
    }
  });

  document.addEventListener('click', (e) => {
    let el;
    if ((el = e.target.closest('[data-role-save]'))) {
      const id = el.dataset.roleSave, v = document.querySelector('[data-role-sel="' + id + '"]').value;
      act(async () => unwrap(await sb.rpc('admin_set_role', { p_user: id, p_role: v })), '已更新權限');
    } else if ((el = e.target.closest('[data-role-remove]'))) {
      if (confirm('移除這位管理員?他會變回一般同學。')) act(async () => unwrap(await sb.rpc('admin_set_role', { p_user: el.dataset.roleRemove, p_role: 'none' })), '已移除管理員');
    } else if (e.target.closest('#btn-add-admin')) {
      const id = $('new-admin-user').value, role = $('new-admin-role').value;
      if (id && confirm('新增這位同學為「' + ROLE_LABEL[role] + '」管理員?')) act(async () => unwrap(await sb.rpc('admin_set_role', { p_user: id, p_role: role })), '已新增管理員');
    }
  });

  document.addEventListener('click', (e) => {
    let el;
    const val = (id) => (document.getElementById(id) ? document.getElementById(id).value.trim() : '');
    if ((el = e.target.closest('[data-dp]'))) {
      const st = el.dataset.dp;
      const note = prompt({ investigating: '開始處理這筆爭議。\n要留什麼說明給同學嗎?(選填,會通知他)', resolved: '標為已解決。\n請填寫處理結果(會通知同學)', dismissed: '結案(不成立)。\n請填寫原因(會通知同學)' }[st], '');
      if (note === null) return;
      act(async () => unwrap(await sb.rpc('admin_update_dispute', { p_id: Number(el.dataset.id), p_status: st, p_note: note })), '已更新');
    } else if ((el = e.target.closest('[data-sem-pick]'))) { semSel = Number(el.dataset.semPick); render();
    } else if ((el = e.target.closest('[data-sem-del]'))) {
      if (confirm('刪除這個學期?底下的課程與教材會一起刪除。')) act(async () => unwrap(await sb.from('semesters').delete().eq('id', el.dataset.semDel)), '已刪除');
    } else if (e.target.closest('#btn-add-sem')) {
      const name = val('sem-name'), s = val('sem-start'), en = val('sem-end');
      if (!name || !s || !en) { toast('請填學期名稱與起迄日期'); return; }
      act(async () => { const r = unwrap(await sb.from('semesters').insert({ name, start_date: s, end_date: en }).select('id').single()); semSel = r.id; }, '已新增學期');
    } else if (e.target.closest('#btn-add-course')) {
      const name = val('course-name'); if (!name) { toast('請填課程名稱'); return; }
      act(async () => unwrap(await sb.from('courses').insert({ semester_id: semSel, dept: val('course-dept'), name, teacher: val('course-teacher') })), '已新增課程');
    } else if ((el = e.target.closest('[data-course-del]'))) {
      if (confirm('刪除這門課程與它的教材?')) act(async () => unwrap(await sb.from('courses').delete().eq('id', el.dataset.courseDel)), '已刪除');
    } else if ((el = e.target.closest('[data-tb-del]'))) {
      act(async () => unwrap(await sb.from('course_textbooks').delete().eq('id', el.dataset.tbDel)), '已刪除');
    } else if ((el = e.target.closest('[data-add-tb]'))) {
      const id = el.dataset.addTb, title = val('tb-title-' + id); if (!title) { toast('請填教材書名'); return; }
      act(async () => unwrap(await sb.from('course_textbooks').insert({ course_id: Number(id), title, isbn: val('tb-isbn-' + id).replace(/[^0-9Xx-]/g, '') })), '已新增教材');
    } else if (e.target.closest('#btn-import')) {
      const lines = val('imp-text').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^系所[,\t,]/.test(l));
      if (!lines.length) { toast('請貼上要匯入的內容'); return; }
      act(async () => {
        const rows = [], bad = [];
        lines.forEach((l, i) => {
          const f = l.split(/[,\t,]/).map((x) => x.trim());
          if (!f[0] || !f[1] || !f[3]) { bad.push(i + 1); return; }
          rows.push({ dept: f[0], name: f[1], teacher: f[2] || '', title: f[3], isbn: (f[4] || '').replace(/[^0-9Xx-]/g, ''), required: !/^(否|參考|n|no|0)$/i.test(f[5] || '') });
        });
        if (bad.length) throw new Error('第 ' + bad.join('、') + ' 行格式不對(系所、課程、教材書名不能空白)');
        const ids = {};
        for (const r of rows) {
          const k = r.dept + '|' + r.name + '|' + r.teacher;
          if (!ids[k]) ids[k] = unwrap(await sb.from('courses').upsert({ semester_id: semSel, dept: r.dept, name: r.name, teacher: r.teacher }, { onConflict: 'semester_id,dept,name,teacher' }).select('id').single()).id;
        }
        unwrap(await sb.from('course_textbooks').upsert(rows.map((r) => ({ course_id: ids[r.dept + '|' + r.name + '|' + r.teacher], title: r.title, isbn: r.isbn, required: r.required })), { onConflict: 'course_id,title' }));
        toast('已匯入 ' + rows.length + ' 本教材、' + Object.keys(ids).length + ' 門課程');
      }, '');
    }
  });

  // ---------- 初始化 ----------
  async function init() {
    if (API.DEMO) {
      gate('<h2 class="font-bold text-lg">尚未設定 Supabase</h2><p class="text-sm text-slate-600">後台需要連接 Supabase。請先依 README 完成設定並填寫 <code>config.js</code>。</p>');
      return;
    }
    me = await API.me();
    if (!me) {
      gate(`<h2 class="font-bold text-lg">管理員登入</h2><p class="text-sm text-slate-600">請輸入管理員的帳號(Email)與密碼。</p>
        <form id="form-login" class="space-y-3 text-left">
          <input name="email" type="email" required autocomplete="username" placeholder="帳號(Email)" class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm">
          <input name="password" type="password" required autocomplete="current-password" placeholder="密碼" class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm">
          <button class="w-full rounded-lg bg-slate-800 text-white font-semibold py-2.5 text-sm">登入</button>
          <p id="login-error" class="hidden text-sm text-red-600"></p>
        </form>`);
      return;
    }
    const { data: { session } } = await sb.auth.getSession();
    const lineAccount = ((session && session.user && session.user.email) || '').endsWith('@line-login.example.com');
    if (me.isAdmin && lineAccount && window.APP_CONFIG.ADMIN_PASSWORD_ONLY !== false) {
      gate(`<h2 class="font-bold text-lg">請改用帳號密碼登入</h2><p class="text-sm text-slate-600">後台只能用管理員的「帳號與密碼」登入,不能用 LINE 登入的帳號。</p><button id="btn-logout" class="w-full rounded-lg bg-slate-800 text-white font-semibold py-2.5 text-sm">登出,改用帳號密碼</button>`);
      return;
    }
    if (!me.isAdmin) {
      gate(`<h2 class="font-bold text-lg">沒有權限</h2><p class="text-sm text-slate-600">「${esc(me.name)}」不是管理員帳號。</p><button id="btn-logout" class="w-full rounded-lg bg-slate-800 text-white font-semibold py-2.5 text-sm">登出</button><a href="./" class="text-blue-600 underline text-sm">回前台</a>`);
      return;
    }
    try { myRole = unwrap(await sb.rpc('admin_role')) || 'super'; } catch (e) { myRole = 'super'; }   // 還沒執行 v3 SQL 時視為最高權限
    $('who').innerHTML = esc(me.name) + '(' + esc(ROLE_LABEL[myRole] || '管理員') + ') ' + (myRole === 'super' ? '<button id="btn-test-account" class="underline ml-2">切換成測試同學</button> ' : '') + '<button id="btn-logout" class="underline ml-2">登出</button>';
    $('gate').classList.add('hidden');
    $('app').classList.remove('hidden');
    render();
  }
  init();
})();
