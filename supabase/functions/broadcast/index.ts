// Supabase Edge Function:管理員廣播(瀏覽器推播 / Email / LINE 官方帳號廣播)
// 只有管理員(admins 表)能呼叫;站內公告由網站直接讀 announcements 表,不經過這裡。
// Secrets:
//   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT   → 推播
//   BREVO_API_KEY / MAIL_FROM                              → Email
//   LINE_BOT_TOKEN(Messaging API 的 Channel access token)  → LINE 廣播(耗用 LINE 訊息額度)
//   SITE_URL                                               → 預設連結
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import webpush from 'npm:web-push@3.6.7';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const chunk = <T>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

    // ---- 驗證呼叫者是管理員 ----
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: u } = await admin.auth.getUser(token);
    if (!u?.user) return json({ error: '請先登入' }, 401);
    const { data: adm } = await admin.from('admins').select('user_id').eq('user_id', u.user.id).maybeSingle();
    if (!adm) return json({ error: '沒有權限' }, 403);

    const { announcement_id, channels } = await req.json();
    const want: string[] = Array.isArray(channels) ? channels : [];
    const { data: a } = await admin.from('announcements').select('id,title,body,link').eq('id', announcement_id).maybeSingle();
    if (!a) return json({ error: '找不到公告' }, 404);

    const site = (Deno.env.get('SITE_URL') || '').replace(/\/$/, '');
    const link = /^https?:\/\//i.test(a.link || '') ? a.link : (site || '');
    const result: Record<string, unknown> = {};

    // ---- 瀏覽器推播 ----
    if (want.includes('push')) {
      const pub = Deno.env.get('VAPID_PUBLIC_KEY');
      const priv = Deno.env.get('VAPID_PRIVATE_KEY');
      if (!pub || !priv) {
        result.push = { sent: 0, failed: 0, error: '尚未設定 VAPID 金鑰' };
      } else {
        webpush.setVapidDetails(Deno.env.get('VAPID_SUBJECT') || 'mailto:admin@example.com', pub, priv);
        const { data: subs } = await admin.from('push_subscriptions').select('id,endpoint,p256dh,auth_key,user_id');
        // 排除停權者
        const { data: banned } = await admin.from('profiles').select('id').eq('banned', true);
        const bannedSet = new Set((banned ?? []).map((b) => b.id));
        let sent = 0, failed = 0;
        const body = JSON.stringify({ title: `📢 ${a.title}`, body: a.body.slice(0, 120), url: link || './', tag: `announce-${a.id}` });
        for (const part of chunk((subs ?? []).filter((s) => !bannedSet.has(s.user_id)), 20)) {
          await Promise.all(part.map(async (s) => {
            try {
              await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } }, body);
              sent++;
            } catch (e) {
              failed++;
              const code = (e as { statusCode?: number }).statusCode;
              if (code === 404 || code === 410) await admin.from('push_subscriptions').delete().eq('id', s.id);
            }
          }));
        }
        result.push = { sent, failed };
      }
    }

    // ---- Email(僅寄給已開啟 Email 通知者)----
    if (want.includes('email')) {
      const key = Deno.env.get('BREVO_API_KEY');
      const from = Deno.env.get('MAIL_FROM');
      if (!key || !from) {
        result.email = { sent: 0, failed: 0, error: '尚未設定 Brevo' };
      } else {
        const { data: ups } = await admin.from('user_private').select('email,user_id').eq('notify_email', true).neq('email', '');
        const { data: banned } = await admin.from('profiles').select('id').eq('banned', true);
        const bannedSet = new Set((banned ?? []).map((b) => b.id));
        let sent = 0, failed = 0;
        const html = `<h3>${escHtml(a.title)}</h3><p style="white-space:pre-wrap">${escHtml(a.body)}</p>` +
          (link ? `<p><a href="${escHtml(link)}">前往查看</a></p>` : '') +
          `<p style="color:#888;font-size:12px">這是「校園二手書」的系統公告。不想收到信,請到網站「我的」→「通知設定」關閉 Email 通知。</p>`;
        for (const part of chunk((ups ?? []).filter((x) => !bannedSet.has(x.user_id)), 10)) {
          await Promise.all(part.map(async (x) => {
            const r = await fetch('https://api.brevo.com/v3/smtp/email', {
              method: 'POST', headers: { 'api-key': key, 'content-type': 'application/json' },
              body: JSON.stringify({ sender: { name: '校園二手書', email: from }, to: [{ email: x.email }], subject: `📢 ${a.title}`, htmlContent: html }),
            });
            if (r.ok) sent++; else failed++;
          }));
        }
        result.email = { sent, failed };
      }
    }

    // ---- LINE 官方帳號廣播(發給所有好友,耗用訊息額度)----
    if (want.includes('line')) {
      const lt = Deno.env.get('LINE_BOT_TOKEN');
      if (!lt) {
        result.line = { ok: false, error: '尚未設定 LINE_BOT_TOKEN' };
      } else {
        const text = `📢 ${a.title}\n\n${a.body}${link ? `\n\n${link}` : ''}`.slice(0, 4900);
        const r = await fetch('https://api.line.me/v2/bot/message/broadcast', {
          method: 'POST', headers: { Authorization: `Bearer ${lt}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: [{ type: 'text', text }] }),
        });
        result.line = r.ok ? { ok: true } : { ok: false, error: `${r.status} ${(await r.text()).slice(0, 120)}` };
      }
    }

    await admin.from('announcements').update({ result }).eq('id', a.id);
    return json(result);
  } catch (e) {
    console.error(e);
    return json({ error: '廣播發生錯誤,請查看函式 Logs' }, 500);
  }
});
