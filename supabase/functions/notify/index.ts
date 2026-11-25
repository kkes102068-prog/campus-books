// Supabase Edge Function:新訊息通知(瀏覽器推播 + Email)
// 由 Database Webhook 在 messages 表 INSERT 時呼叫(設定方式見 README)。
// 需要 Secrets:
//   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT(例 mailto:you@example.com)  → 瀏覽器推播
//   SITE_URL(網站網址,結尾不加 /)                                                  → 通知中的連結
//   BREVO_API_KEY / MAIL_FROM(已在 Brevo 驗證的寄件信箱)                           → Email(沒設定就不寄信)
// 通知內容刻意不含聊天內容,只提示「哪本書有新訊息」。
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import webpush from 'npm:web-push@3.6.7';

const EMAIL_THROTTLE_MS = 5 * 60 * 1000; // 手機推播:每則新訊息都通知(免費、不限量);Email:同一串聊聊 5 分鐘內最多一封(保護寄信額度)
const ok = () => new Response('ok');
const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

Deno.serve(async (req) => {
  try {
    const payload = await req.json();
    const m = payload?.record;
    if (payload?.type !== 'INSERT' || !m || !m.sender_id) return ok();

    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

    const { data: t } = await sb.from('threads')
      .select('id,buyer_id,seller_id,book:books(title),wish:wishes(title)').eq('id', m.thread_id).maybeSingle();
    if (!t) return ok();
    const to = t.buyer_id === m.sender_id ? t.seller_id : t.seller_id === m.sender_id ? t.buyer_id : null;
    if (!to) return ok();

    const { data: prof } = await sb.from('profiles').select('banned').eq('id', to).maybeSingle();
    if (!prof || prof.banned) return ok();

    // Email 節流(推播不節流)
    const { data: log } = await sb.from('notify_log').select('last_notified_at').eq('thread_id', t.id).eq('user_id', to).maybeSingle();
    const emailThrottled = !!log && Date.now() - new Date(log.last_notified_at).getTime() < EMAIL_THROTTLE_MS;

    const title = ((t.book as { title: string } | null)?.title) ?? ((t.wish as { title: string } | null)?.title) ?? '聊聊';
    const site = (Deno.env.get('SITE_URL') || '').replace(/\/$/, '');
    const url = `${site}/?tab=chat&thread=${t.id}`;
    let emailSent = false;

    // ---- 瀏覽器推播 ----
    const pub = Deno.env.get('VAPID_PUBLIC_KEY');
    const priv = Deno.env.get('VAPID_PRIVATE_KEY');
    if (pub && priv) {
      webpush.setVapidDetails(Deno.env.get('VAPID_SUBJECT') || 'mailto:admin@example.com', pub, priv);
      const { data: subs } = await sb.from('push_subscriptions').select('id,endpoint,p256dh,auth_key').eq('user_id', to);
      for (const s of subs ?? []) {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } },
            JSON.stringify({ title: '校園二手書', body: `《${title}》有新訊息`, url, tag: `${t.id}-${m.id}` }),   // 每則訊息一個獨立通知
          );
        } catch (e) {
          const code = (e as { statusCode?: number }).statusCode;
          if (code === 404 || code === 410) await sb.from('push_subscriptions').delete().eq('id', s.id); // 訂閱已失效
          else console.error('push failed', code);
        }
      }
    }

    // ---- Email(使用者有開啟才寄)----
    const brevoKey = Deno.env.get('BREVO_API_KEY');
    const mailFrom = Deno.env.get('MAIL_FROM');
    if (brevoKey && mailFrom && !emailThrottled) {
      const { data: up } = await sb.from('user_private').select('email,notify_email').eq('user_id', to).maybeSingle();
      if (up?.notify_email && up.email) {
        const res = await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: { 'api-key': brevoKey, 'content-type': 'application/json' },
          body: JSON.stringify({
            sender: { name: '校園二手書', email: mailFrom },
            to: [{ email: up.email }],
            subject: `《${title}》有新訊息`,
            htmlContent: `<p>你在《${escHtml(title)}》有新訊息。</p><p><a href="${escHtml(url)}">前往查看</a></p>` +
              `<p style="color:#888;font-size:12px">不想收到這類信件,請到網站「我的」→「通知設定」關閉 Email 通知。</p>`,
          }),
        });
        if (res.ok) emailSent = true; else console.error('email failed', res.status, await res.text());
      }
    }

    if (emailSent) {
      await sb.from('notify_log').upsert({ thread_id: t.id, user_id: to, last_notified_at: new Date().toISOString() });
    }
    return ok();
  } catch (e) {
    console.error(e);
    return new Response('error', { status: 500 });
  }
});
