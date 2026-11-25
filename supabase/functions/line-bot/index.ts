// Supabase Edge Function:LINE 官方帳號機器人(Messaging API Webhook)
// 功能:在 LINE 直接搜尋二手書(書名/課程/老師/系所),以卡片呈現,按鈕連回網站;
//       選單指令:賣書、許願、聊聊、說明、條款。只使用「回覆訊息」,不耗 LINE 推播額度。
//
// ⚠️ 部署時必須「關閉 Verify JWT」(Edge Functions → line-bot → Settings → Enforce JWT Verification 關閉),
//    因為呼叫者是 LINE 伺服器;本函式自行驗證 LINE 簽章。
// Secrets:
//   LINE_BOT_CHANNEL_SECRET   Messaging API channel 的 Channel secret(用來驗證簽章)
//   LINE_BOT_TOKEN            Messaging API channel 的 Channel access token(long-lived)
//   SITE_URL                  網站網址,結尾不加 /
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const SITE = (Deno.env.get('SITE_URL') || '').replace(/\/$/, '');
const TOKEN = Deno.env.get('LINE_BOT_TOKEN') || '';
const SECRET = Deno.env.get('LINE_BOT_CHANNEL_SECRET') || '';
const ORANGE = '#F97316';

async function validSignature(body: string, signature: string | null): Promise<boolean> {
  if (!signature || !SECRET) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  const expected = btoa(String.fromCharCode(...mac));
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

async function reply(replyToken: string, messages: unknown[]) {
  const r = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ replyToken, messages: messages.slice(0, 5) }),
  });
  if (!r.ok) console.error('reply failed', r.status, await r.text());
}

const uriBtn = (label: string, uri: string, primary = false) => ({
  type: 'button', style: primary ? 'primary' : 'secondary', height: 'sm', color: primary ? ORANGE : undefined,
  action: { type: 'uri', label, uri },
});

function menuBubble(title: string, text: string) {
  return {
    type: 'flex', altText: title,
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', spacing: 'md',
        contents: [
          { type: 'text', text: title, weight: 'bold', size: 'lg', wrap: true },
          { type: 'text', text, size: 'sm', color: '#666666', wrap: true },
        ],
      },
      footer: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          uriBtn('🔍 逛逛二手書', `${SITE}/`, true),
          uriBtn('📖 我要賣書', `${SITE}/?sell=1`),
          uriBtn('🙏 我要許願', `${SITE}/?wish=1`),
          uriBtn('💬 我的聊聊', `${SITE}/?tab=chat`),
        ],
      },
    },
  };
}

const GROUP_HELP = '在群組裡 @我 再加關鍵字就能搜書,例如:\n@校園二手書 微積分\n@校園二手書 王老師\n\n(也可以輸入「找書 微積分」)';
const HELP = '直接輸入「書名、課程、老師或系所」就能搜尋,例如:\n・微積分\n・王老師\n・護理系 解剖\n\n其他指令:賣書、許願、聊聊、條款';

function bookBubble(b: Record<string, unknown>) {
  const img = typeof b.image_url === 'string' && /^https:\/\//.test(b.image_url) ? b.image_url : null;
  const lines: string[] = [];
  if (b.course) lines.push(`課程:${b.course}`);
  if (b.teacher) lines.push(`老師:${b.teacher}`);
  if (b.course_dept) lines.push(`開課系所:${b.course_dept}`);
  const ways = [b.allow_meetup ? '🤝面交' : '', b.allow_shipping ? '📦寄送' : ''].filter(Boolean).join(' ');
  return {
    type: 'bubble', size: 'kilo',
    ...(img ? { hero: { type: 'image', url: img, size: 'full', aspectRatio: '4:3', aspectMode: 'cover' } } : {}),
    body: {
      type: 'box', layout: 'vertical', spacing: 'sm',
      contents: [
        { type: 'text', text: String(b.title), weight: 'bold', size: 'md', wrap: true },
        { type: 'text', text: `NT$ ${b.price}`, weight: 'bold', size: 'xl', color: ORANGE },
        ...lines.map((t) => ({ type: 'text', text: t, size: 'xs', color: '#666666', wrap: true })),
        ...(ways ? [{ type: 'text', text: ways, size: 'xs', color: '#888888' }] : []),
      ],
    },
    footer: { type: 'box', layout: 'vertical', contents: [uriBtn('查看 / 我想買', `${SITE}/?book=${b.id}`, true)] },
  };
}

async function searchBooks(q: string) {
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  // 移除會破壞 PostgREST 篩選語法的字元
  const tokens = q.split(/\s+/).map((t) => t.replace(/[,()%*\\:"'`]/g, '')).filter(Boolean).slice(0, 4);
  let query = sb.from('books')
    .select('id,title,price,image_url,course,teacher,course_dept,allow_meetup,allow_shipping')
    .eq('status', 'active').order('created_at', { ascending: false }).limit(10);
  for (const t of tokens) {
    query = query.or(`title.ilike.%${t}%,course.ilike.%${t}%,teacher.ilike.%${t}%,course_dept.ilike.%${t}%,author.ilike.%${t}%`);
  }
  const { data, error } = await query;
  if (error) { console.error(error); return []; }
  return data ?? [];
}

// deno-lint-ignore no-explicit-any
async function handle(ev: Record<string, any>) {
  const rt: string | undefined = ev.replyToken;
  if (!rt) return;

  if (ev.type === 'follow') {
    return reply(rt, [
      { type: 'text', text: '👋 歡迎使用「校園二手書」!\n\n' + HELP },
      menuBubble('校園二手書', '買賣、許願、聊聊都在網站完成;用 LINE 登入即可。'),
    ]);
  }
  // 群組 / 多人聊天室:只在有人明確輸入「找書 關鍵字」時才回應,其他閒聊一律不理(避免洗版)
  const inGroup = ev.source?.type === 'group' || ev.source?.type === 'room';

  if (ev.type === 'join') {   // 機器人被邀請進群組
    return reply(rt, [
      { type: 'text', text: '👋 大家好,我是校園二手書小幫手!\n\n在群組裡 @我 再加關鍵字就能搜書,例如:\n@校園二手書 微積分\n@校園二手書 王老師\n(也可以輸入「找書 微積分」)\n\n買賣、許願、聊聊請加我好友或用下面的按鈕。' },
      menuBubble('校園二手書', '買賣、許願、聊聊都在網站完成;用 LINE 登入即可。'),
    ]);
  }

  if (ev.type !== 'message' || ev.message?.type !== 'text') {
    if (ev.type === 'message' && !inGroup) return reply(rt, [{ type: 'text', text: '目前只看得懂文字喔 😊\n\n' + HELP }]);
    return;
  }

  const text: string = String(ev.message.text).trim().slice(0, 100);
  let query = text;

  if (inGroup) {
    // 觸發方式 1:@標註機器人(LINE 會在 mention.mentionees 裡標明哪一個是機器人自己 isSelf)
    // 觸發方式 2:以「找書 / 搜書」開頭,或單獨輸入「二手書」
    // 其他群組聊天一律不回應
    // deno-lint-ignore no-explicit-any
    const selfMentions = ((ev.message.mention?.mentionees ?? []) as any[]).filter((x) => x.isSelf);
    let q: string | null = null;
    if (selfMentions.length) {
      let t = String(ev.message.text);
      for (const x of selfMentions.slice().sort((m1, m2) => m2.index - m1.index)) t = t.slice(0, x.index) + t.slice(x.index + x.length);
      q = t.trim().replace(/^(?:找書|搜書)\s*/, '').trim();   // 允許「@機器人 找書 微積分」
    } else {
      const m = text.match(/^(?:找書|搜書)\s*(.*)$/);
      if (m) q = m[1].trim(); else if (text === '二手書') q = '';
    }
    if (q === null) return;                                  // 一般聊天:完全不回應
    query = q.slice(0, 100);
    if (!query) return reply(rt, [{ type: 'text', text: GROUP_HELP }, menuBubble('校園二手書', '快速入口')]);
  } else {
    if (/^(賣書|我要賣書|上架)$/.test(text)) return reply(rt, [menuBubble('📖 上架二手書', '點下面按鈕開啟上架表單(首次使用需登入並簽署同意書)。')]);
    if (/^(許願|我要許願)$/.test(text)) return reply(rt, [menuBubble('🙏 許願池', '找不到想買的書?到許願池許願,有同學有書會在站內跟你聊聊。')]);
    if (/^(聊聊|訊息|我的聊聊)$/.test(text)) return reply(rt, [menuBubble('💬 我的聊聊', '聊聊在網站內進行,點下面按鈕前往。')]);
    if (/^(條款|同意書|隱私|隱私權|免責)/.test(text)) return reply(rt, [{ type: 'text', text: `使用條款、免責聲明與隱私權告知:\n${SITE}/terms.html` }]);
    if (/^(說明|幫助|help|menu|選單|\?|？)$/i.test(text)) return reply(rt, [{ type: 'text', text: HELP }, menuBubble('校園二手書', '快速入口')]);
  }

  const books = await searchBooks(query);
  if (!books.length) {
    return reply(rt, [
      { type: 'text', text: `找不到與「${query}」相關、目前未售出的書 😢\n換個關鍵字試試,或到許願池許願,有同學有書會聯絡你。` },
      { type: 'flex', altText: '去許願', contents: { type: 'bubble', footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
        uriBtn('🙏 去許願', `${SITE}/?wish=1`, true), uriBtn('🔍 到網站搜尋', `${SITE}/?q=${encodeURIComponent(query)}`),
      ] } } },
    ]);
  }
  return reply(rt, [
    { type: 'text', text: `找到 ${books.length >= 10 ? '10+' : books.length} 本與「${query}」相關、未售出的書 👇` },
    { type: 'flex', altText: `「${query}」的搜尋結果`, contents: { type: 'carousel', contents: books.map(bookBubble) } },
    { type: 'text', text: `看更多:${SITE}/?q=${encodeURIComponent(query)}` },
  ]);
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('line-bot ok');
  const raw = await req.text();
  if (!(await validSignature(raw, req.headers.get('x-line-signature')))) return new Response('invalid signature', { status: 401 });
  try {
    const { events } = JSON.parse(raw);
    await Promise.all((events ?? []).map((e: Record<string, unknown>) => handle(e).catch((err) => console.error(err))));
  } catch (e) { console.error(e); }
  return new Response('ok'); // LINE 要求 200
});
