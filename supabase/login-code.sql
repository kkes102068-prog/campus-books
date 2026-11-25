-- 登入碼(讓 iPhone 主畫面 App 用「已在 Safari 登入」的帳號接力登入)
-- 6 位數字、3 分鐘有效、限用一次;輸錯過多會暫時鎖定。
-- 可重複執行;只新增/更新資料表與函式,不會刪除任何使用者資料。請貼到 Supabase → SQL Editor 執行。

create table if not exists public.login_codes (
  code_hash  text primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null
);
alter table public.login_codes enable row level security;        -- 不開任何 policy:前端不能直接讀寫

create table if not exists public.login_code_fails (at timestamptz not null default now());
alter table public.login_code_fails enable row level security;   -- 記錄輸錯次數,用來防暴力猜測

-- 已登入的使用者產生 6 位數字登入碼
create or replace function public.create_login_code() returns text
language plpgsql security definer set search_path = public, extensions as $$
declare
  uid uuid := auth.uid();
  raw bytea;
  c text;
  h text;
  tries int := 0;
begin
  if uid is null then raise exception '請先登入'; end if;
  delete from public.login_codes where user_id = uid or expires_at < now();
  loop
    raw := gen_random_bytes(4);
    c := lpad((((get_byte(raw,0)::bigint << 24) + (get_byte(raw,1)::bigint << 16) + (get_byte(raw,2)::bigint << 8) + get_byte(raw,3)) % 1000000)::text, 6, '0');
    h := encode(digest(c, 'sha256'), 'hex');
    exit when not exists (select 1 from public.login_codes where code_hash = h);
    tries := tries + 1;
    if tries > 20 then raise exception '請稍後再試'; end if;
  end loop;
  insert into public.login_codes (code_hash, user_id, expires_at) values (h, uid, now() + interval '3 minutes');
  return c;
end $$;
revoke all on function public.create_login_code() from public, anon;
grant execute on function public.create_login_code() to authenticated;

-- 只給 Edge Function(service_role)使用:驗證並銷毀登入碼,回傳 user_id
-- 10 分鐘內輸錯達 20 次,就暫時不接受任何登入碼
create or replace function public.redeem_login_code(p_hash text) returns uuid
language plpgsql security definer set search_path = public as $$
declare uid uuid;
begin
  delete from public.login_code_fails where at < now() - interval '1 hour';
  if (select count(*) from public.login_code_fails where at > now() - interval '10 minutes') >= 20 then
    return null;
  end if;
  delete from public.login_codes where code_hash = p_hash and expires_at > now() returning user_id into uid;
  if uid is null then insert into public.login_code_fails default values; end if;
  return uid;
end $$;
revoke all on function public.redeem_login_code(text) from public, anon, authenticated;
grant execute on function public.redeem_login_code(text) to service_role;
