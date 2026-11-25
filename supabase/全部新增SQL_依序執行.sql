-- 北護校園二手書平台:新功能的 SQL(合併版,依序執行)
-- 內容:登入碼、聯絡管理員、自訂暱稱、自選頭像、上架編輯與多張照片
-- 可重複執行;只新增欄位與函式,不會刪除任何資料。

-- ================= login-code.sql =================
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

-- ================= support-chat.sql =================
-- 聯絡管理員(客服聊聊)
-- 使用者在聊聊頁按「聯絡管理員」,就會開一條與管理員的對話(沿用現有聊聊與通知)。
-- 可重複執行;只新增欄位、索引與函式,不會刪除任何資料。請貼到 Supabase → SQL Editor 執行。

alter table public.threads add column if not exists kind text not null default 'trade';
do $$ begin
  alter table public.threads add constraint threads_kind_check check (kind in ('trade','support'));
exception when duplicate_object then null; end $$;

-- 每位使用者最多一條客服對話
create unique index if not exists threads_support_uniq on public.threads (buyer_id) where kind = 'support';

-- 對話的另一方是「第一位管理員」(admins 表依 user_id 排序取第一位)
create or replace function public.start_support_thread() returns uuid
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); adm uuid; t public.threads; tid uuid;
begin
  if uid is null or not public.is_active_user() then raise exception '請先登入'; end if;
  if public.is_admin() then raise exception '你就是管理員,不需要聯絡自己'; end if;
  select user_id into adm from public.admins order by user_id limit 1;
  if adm is null then raise exception '目前沒有設定管理員'; end if;

  select * into t from public.threads where buyer_id = uid and kind = 'support';
  if found then
    if t.status <> 'open' then
      update public.threads set status = 'open', seller_id = adm, updated_at = now() where id = t.id;
      insert into public.messages (thread_id, sender_id, body, is_system)
        values (t.id, uid, '使用者重新開啟了客服對話。', true);
    end if;
    return t.id;
  end if;

  insert into public.threads (buyer_id, seller_id, kind) values (uid, adm, 'support') returning id into tid;
  insert into public.messages (thread_id, sender_id, body, is_system)
    values (tid, uid, '你好!有任何問題都可以在這裡留言,管理員看到後會回覆你。', true);
  return tid;
end $$;
revoke all on function public.start_support_thread() from public, anon;
grant execute on function public.start_support_thread() to authenticated;

-- ================= nickname.sql =================
-- 自訂暱稱:第一次使用時設定,之後可以修改;設定後登入時不再被 LINE 暱稱覆蓋。
-- 可重複執行;只新增欄位與函式,不會刪除任何資料。請貼到 Supabase → SQL Editor 執行。
alter table public.user_private add column if not exists name_set boolean not null default false;

create or replace function public.set_my_name(p_name text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception '請先登入'; end if;
  if exists (select 1 from public.profiles where id = auth.uid() and banned) then raise exception '此帳號已被停權'; end if;
  p_name := btrim(coalesce(p_name, ''));
  if char_length(p_name) not between 1 and 20 then raise exception '暱稱請輸入 1 到 20 個字'; end if;
  update public.profiles set display_name = p_name where id = auth.uid();
  update public.user_private set name_set = true where user_id = auth.uid();
end $$;
revoke all on function public.set_my_name(text) from public, anon;
grant execute on function public.set_my_name(text) to authenticated;

-- ================= avatar.sql =================
-- 自選頭像:使用者可從內建圖示中選一個(存成 'e:🐱' 這種文字),不使用 LINE 頭貼。
-- 可重複執行;只新增函式。請貼到 Supabase → SQL Editor 執行。
create or replace function public.set_my_avatar(p_avatar text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception '請先登入'; end if;
  if exists (select 1 from public.profiles where id = auth.uid() and banned) then raise exception '此帳號已被停權'; end if;
  p_avatar := coalesce(btrim(p_avatar), '');
  if p_avatar <> '' and p_avatar !~ '^e:[^<>"''&]{1,8}$' then raise exception '頭像格式不正確'; end if;
  update public.profiles set picture_url = p_avatar where id = auth.uid();
end $$;
revoke all on function public.set_my_avatar(text) from public, anon;
grant execute on function public.set_my_avatar(text) to authenticated;

-- ================= book-edit.sql =================
-- 上架後可編輯 + 一本書最多 5 張照片
-- 可重複執行;只新增欄位與函式,不會刪除任何資料。請貼到 Supabase → SQL Editor 執行。

-- 封面照仍放在 image_url;其餘照片(最多 4 張)放在 extra_images
alter table public.books add column if not exists extra_images text[] not null default '{}';
do $$ begin
  alter table public.books add constraint books_extra_images_check check (cardinality(extra_images) <= 4);
exception when duplicate_object then null; end $$;

-- 賣家編輯自己的書(狀態仍只能用 set_book_status 改;已下架或已售出不能編輯)
create or replace function public.update_my_book(
  p_book uuid, p_title text, p_author text, p_course text, p_teacher text, p_course_dept text,
  p_price integer, p_note text, p_allow_meetup boolean, p_allow_shipping boolean,
  p_meetup_place text, p_shipping_fee integer, p_image_url text, p_extra_images text[]
) returns void
language plpgsql security definer set search_path = public as $$
declare b public.books; u text;
begin
  if auth.uid() is null or not public.is_active_user() then raise exception '請先登入'; end if;
  select * into b from public.books where id = p_book;
  if not found or b.seller_id <> auth.uid() then raise exception '找不到這本書'; end if;
  if b.status not in ('active','reserved') then raise exception '這本書目前不能編輯'; end if;
  p_extra_images := coalesce(p_extra_images, '{}');
  if p_image_url is null or p_image_url !~ '^https://' then raise exception '請至少保留一張照片'; end if;
  foreach u in array p_extra_images loop
    if u !~ '^https://' or char_length(u) > 500 then raise exception '照片網址不正確'; end if;
  end loop;
  update public.books set
    title = btrim(p_title), author = btrim(coalesce(p_author, '')), course = btrim(coalesce(p_course, '')),
    teacher = btrim(coalesce(p_teacher, '')), course_dept = coalesce(p_course_dept, ''),
    price = p_price, note = btrim(coalesce(p_note, '')),
    allow_meetup = p_allow_meetup, allow_shipping = p_allow_shipping,
    meetup_place = btrim(coalesce(p_meetup_place, '')), shipping_fee = coalesce(p_shipping_fee, 0),
    image_url = p_image_url, extra_images = p_extra_images
  where id = p_book;
end $$;
revoke all on function public.update_my_book(uuid, text, text, text, text, text, integer, text, boolean, boolean, text, integer, text, text[]) from public, anon;
grant execute on function public.update_my_book(uuid, text, text, text, text, text, integer, text, boolean, boolean, text, integer, text, text[]) to authenticated;

