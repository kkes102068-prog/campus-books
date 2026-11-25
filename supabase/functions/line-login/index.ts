// Supabase Edge Function:LINE Login → Supabase 登入
// 前端把 LINE 回傳的 code 交給這裡;LINE Channel Secret 只存在伺服器端。
// 部署需設定 Secrets:LINE_CHANNEL_ID、LINE_CHANNEL_SECRET
// (SUPABASE_URL 與 SUPABASE_SERVICE_ROLE_KEY 由 Supabase 自動提供)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const form = (o: Record<string, string>) => new URLSearchParams(o);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const body = await req.json();
    const { code, redirect_uri } = body;

    // 登入碼:iPhone 主畫面 App 接力登入(先在 Safari 用 LINE 登入並產生登入碼)
    if (body.login_code) {
      const norm = String(body.login_code).replace(/\D/g, '');
      if (norm.length !== 6) return json({ error: '登入碼要是 6 位數字' }, 400);
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(norm))))
        .map((b) => b.toString(16).padStart(2, '0')).join('');
      const adm = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
      const { data: uid } = await adm.rpc('redeem_login_code', { p_hash: hash });
      if (!uid) return json({ error: '登入碼錯誤、已過期,或輸錯次數過多(請稍後再試)' }, 401);
      const { data: pf } = await adm.from('profiles').select('banned').eq('id', uid).single();
      if (pf?.banned) return json({ error: '此帳號已被停權,如有疑問請聯絡管理員' }, 403);
      const { data: u } = await adm.auth.admin.getUserById(uid);
      if (!u?.user?.email) return json({ error: '登入發生錯誤,請稍後再試' }, 500);
      await adm.from('login_logs').insert({
        user_id: uid,
        ip: (req.headers.get('x-forwarded-for') || '').split(',')[0].trim(),
        user_agent: ('[登入碼] ' + (req.headers.get('user-agent') || '')).slice(0, 300),
      });
      const { data: lk, error: lkErr } = await adm.auth.admin.generateLink({ type: 'magiclink', email: u.user.email });
      if (lkErr || !lk.properties?.hashed_token) throw lkErr ?? new Error('產生登入憑證失敗');
      return json({ token_hash: lk.properties.hashed_token });
    }

    if (!code || !redirect_uri) return json({ error: '缺少參數' }, 400);

    const channelId = Deno.env.get('LINE_CHANNEL_ID')!;
    const channelSecret = Deno.env.get('LINE_CHANNEL_SECRET')!;

    // 1. code 換 token
    const tokenRes = await fetch('https://api.line.me/oauth2/v2.1/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({
        grant_type: 'authorization_code', code, redirect_uri,
        client_id: channelId, client_secret: channelSecret,
      }),
    });
    const tok = await tokenRes.json();
    if (!tokenRes.ok || !tok.id_token) return json({ error: 'LINE 登入失敗,請重試' }, 401);

    // 2. 驗證 id_token,取得使用者資料
    const verifyRes = await fetch('https://api.line.me/oauth2/v2.1/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({ id_token: tok.id_token, client_id: channelId }),
    });
    const prof = await verifyRes.json();
    if (!verifyRes.ok || !prof.sub) return json({ error: 'LINE 身分驗證失敗' }, 401);

    const sub: string = prof.sub;
    const name: string = (prof.name || 'LINE 使用者').slice(0, 100);
    const picture = ''; // 匿名:不儲存 LINE 頭貼
    const lineEmail: string = (prof.email || '').slice(0, 200); // 需在 LINE 後台申請 email 權限才會有值

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false } },
    );

    // 3. 找或建立使用者
    const email = `line_${sub.toLowerCase()}@line-login.example.com`;
    const { data: priv } = await admin.from('user_private')
      .select('user_id, login_count, name_set').eq('line_user_id', sub).maybeSingle();

    let userId: string;
    let count = 0;
    if (priv) {
      userId = priv.user_id;
      count = priv.login_count;
    } else {
      const { data, error } = await admin.auth.admin.createUser({
        email, email_confirm: true, user_metadata: { provider: 'line' },
      });
      if (error || !data.user) throw error ?? new Error('建立使用者失敗');
      userId = data.user.id;
      const r1 = await admin.from('profiles').insert({ id: userId, display_name: name, picture_url: picture });
      if (r1.error) throw r1.error;
      const r2 = await admin.from('user_private').insert({ user_id: userId, line_user_id: sub, email: lineEmail });
      if (r2.error) throw r2.error;
    }

    // 4. 停權檢查
    const { data: p } = await admin.from('profiles').select('banned, ban_reason').eq('id', userId).single();
    if (p?.banned) return json({ error: '此帳號已被停權' + (p.ban_reason ? '(原因:' + p.ban_reason + ')' : '') + ',如有疑問請聯絡管理員' }, 403);

    // 5. 更新資料並寫入登入紀錄
    // 頭像、暱稱由使用者自訂:設定過暱稱後,登入時不再用 LINE 暱稱覆蓋
    if (!priv?.name_set) await admin.from('profiles').update({ display_name: name }).eq('id', userId);
    await admin.from('user_private')
      .update({ last_login_at: new Date().toISOString(), login_count: count + 1, ...(lineEmail ? { email: lineEmail } : {}) })
      .eq('user_id', userId);
    await admin.from('login_logs').insert({
      user_id: userId,
      ip: (req.headers.get('x-forwarded-for') || '').split(',')[0].trim(),
      user_agent: (req.headers.get('user-agent') || '').slice(0, 300),
    });

    // 6. 產生一次性登入憑證,前端用 verifyOtp 換成正式 session
    // 使用者可能已把登入 Email 改成自己的信箱,所以用 id 查現在的 Email
    const { data: au } = await admin.auth.admin.getUserById(userId);
    const authEmail = au?.user?.email ?? email;
    const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email: authEmail });
    if (linkErr || !link.properties?.hashed_token) throw linkErr ?? new Error('產生登入憑證失敗');
    return json({ token_hash: link.properties.hashed_token });
  } catch (e) {
    console.error(e);
    return json({ error: '登入發生錯誤,請稍後再試' }, 500);
  }
});
