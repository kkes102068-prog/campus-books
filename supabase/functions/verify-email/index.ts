// Supabase Edge Function:在校生驗證(學校 Email 驗證碼)
// 前端先呼叫 { action: 'send', email } 寄 6 位數驗證碼,再呼叫 { action: 'verify', code } 驗證。
// 需要 Secrets:
//   BREVO_API_KEY / MAIL_FROM            已在 Brevo 驗證的寄件信箱(沒設定就無法寄信)
//   ALLOWED_EMAIL_DOMAINS(選填)        允許的學校信箱網域,逗號分隔,預設 ntunhs.edu.tw(含其子網域)
// 部署時請保持「Verify JWT」開啟:呼叫者必須是已登入的使用者。
// (SUPABASE_URL、SUPABASE_ANON_KEY、SUPABASE_SERVICE_ROLE_KEY 由 Supabase 自動提供)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function domainAllowed(email: string): boolean {
  const domains = (Deno.env.get('ALLOWED_EMAIL_DOMAINS') || 'ntunhs.edu.tw')
    .split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
  const host = email.split('@')[1] || '';
  return domains.some((d) => host === d || host.endsWith('.' + d));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const authHeader = req.headers.get('Authorization') || '';
    // 用呼叫者的登入憑證確認他是誰
    const userClient = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } }, auth: { persistSession: false },
    });
    const { data: u } = await userClient.auth.getUser();
    const uid = u?.user?.id;
    if (!uid) return json({ error: '請先登入' }, 401);

    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
    const { data: pf } = await admin.from('profiles').select('banned').eq('id', uid).maybeSingle();
    if (!pf) return json({ error: '找不到你的帳號' }, 404);
    if (pf.banned) return json({ error: '此帳號已被停權' }, 403);

    const body = await req.json();

    if (body.action === 'send') {
      const email = String(body.email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120) return json({ error: 'Email 格式不正確' }, 400);
      if (!domainAllowed(email)) return json({ error: '請使用學校信箱註冊(例如 學號@ntunhs.edu.tw)' }, 400);

      const brevoKey = Deno.env.get('BREVO_API_KEY');
      const mailFrom = Deno.env.get('MAIL_FROM');
      if (!brevoKey || !mailFrom) return json({ error: '系統尚未設定寄信功能,請聯絡管理員' }, 503);

      const code = String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
      const { data: res, error } = await admin.rpc('put_email_code', { p_user: uid, p_email: email, p_hash: await sha256(uid + ':' + code) });
      if (error) throw error;
      if (res === 'taken') return json({ error: '這個學校信箱已經被其他帳號註冊了' }, 409);
      if (res === 'cooldown') return json({ error: '寄得太頻繁了,請 1 分鐘後再試' }, 429);
      if (res === 'daily') return json({ error: '今天寄送的次數已達上限,請明天再試' }, 429);

      const mail = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': brevoKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          sender: { name: '北護校園二手書', email: mailFrom },
          to: [{ email }],
          subject: '北護校園二手書 驗證碼',
          htmlContent: `<p>你的驗證碼是:</p><p style="font-size:28px;letter-spacing:6px;font-weight:bold">${code}</p>` +
            `<p>10 分鐘內有效。如果不是你本人操作,請忽略這封信。</p>`,
        }),
      });
      if (!mail.ok) { console.error('mail failed', mail.status, await mail.text()); return json({ error: '寄信失敗,請稍後再試' }, 502); }
      return json({ ok: true });
    }

    if (body.action === 'verify') {
      const code = String(body.code || '').replace(/\D/g, '');
      if (code.length !== 6) return json({ error: '驗證碼是 6 位數字' }, 400);
      const { data: res, error } = await admin.rpc('check_email_code', { p_user: uid, p_hash: await sha256(uid + ':' + code) });
      if (error) throw error;
      const msg: Record<string, string> = {
        invalid: '驗證碼不正確', expired: '驗證碼已過期,請重新寄送', locked: '輸錯太多次了,請重新寄送驗證碼',
        none: '請先寄送驗證碼', taken: '這個學校信箱已經被其他帳號註冊了',
      };
      if (res !== 'ok') return json({ error: msg[res as string] || '驗證失敗' }, 400);
      return json({ ok: true });
    }

    return json({ error: '不支援的操作' }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: '發生錯誤,請稍後再試' }, 500);
  }
});
