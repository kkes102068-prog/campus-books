-- v3:收藏、賣家統計、書籍詳細欄位、搜尋紀錄、管理員分級、營運統計、安全收緊、刪除帳號
-- 在 Supabase SQL Editor 貼上執行(可重複執行)。需先執行 school-rules / student-card / own-login / admin-tools。

-- ============ 1. 書籍詳細欄位 ============
alter table public.books add column if not exists isbn text not null default '';
alter table public.books add column if not exists publisher text not null default '';
alter table public.books add column if not exists pub_year smallint;
alter table public.books add column if not exists edition text not null default '';
do $$ begin
  alter table public.books add constraint books_meta_check check (
    char_length(isbn) <= 17 and char_length(publisher) <= 40 and char_length(edition) <= 20 and char_length(condition) <= 20
    and (pub_year is null or pub_year between 1900 and 2100));
exception when duplicate_object then null; end $$;
create index if not exists books_price_idx on public.books (price);

create or replace function public.update_my_book_meta(p_book uuid, p_condition text, p_isbn text, p_publisher text, p_year integer, p_edition text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or not public.is_active_user() then raise exception '請先登入'; end if;
  update public.books set condition = left(btrim(coalesce(p_condition, '')), 20), isbn = left(regexp_replace(coalesce(p_isbn, ''), '[^0-9Xx-]', '', 'g'), 17),
         publisher = left(btrim(coalesce(p_publisher, '')), 40), pub_year = case when p_year between 1900 and 2100 then p_year else null end,
         edition = left(btrim(coalesce(p_edition, '')), 20)
   where id = p_book and seller_id = auth.uid() and status in ('active', 'reserved');
  if not found then raise exception '找不到這本書,或目前不能編輯'; end if;
end $$;
revoke all on function public.update_my_book_meta(uuid, text, text, text, integer, text) from public, anon;
grant execute on function public.update_my_book_meta(uuid, text, text, text, integer, text) to authenticated;

-- ============ 2. 收藏 ============
create table if not exists public.favorites (
  user_id       uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  book_id       uuid not null references public.books(id) on delete cascade,
  price_at_save integer not null default 0,
  created_at    timestamptz not null default now(),
  primary key (user_id, book_id)
);
create index if not exists favorites_book_idx on public.favorites (book_id);
alter table public.favorites enable row level security;
drop policy if exists favorites_own_read on public.favorites;
create policy favorites_own_read on public.favorites for select to authenticated using (user_id = auth.uid());
drop policy if exists favorites_own_insert on public.favorites;
create policy favorites_own_insert on public.favorites for insert to authenticated
  with check (user_id = auth.uid() and public.is_active_user() and (select count(*) from public.favorites f where f.user_id = auth.uid()) < 200);
drop policy if exists favorites_own_delete on public.favorites;
create policy favorites_own_delete on public.favorites for delete to authenticated using (user_id = auth.uid());
-- 收藏當下的價格由資料庫記錄(使用者不能自己填),用來判斷之後有沒有降價
create or replace function public.favorites_set_price() returns trigger language plpgsql security definer set search_path = public as $$
begin
  select price into new.price_at_save from public.books where id = new.book_id;
  if new.price_at_save is null then raise exception '找不到這本書'; end if;
  return new;
end $$;
drop trigger if exists favorites_set_price on public.favorites;
create trigger favorites_set_price before insert on public.favorites for each row execute function public.favorites_set_price();

-- ============ 3. 賣家個人頁(匿名:只顯示代號與統計)============
create or replace function public.seller_stats(p_seller uuid) returns json
language plpgsql stable security definer set search_path = public as $$
declare r json;
begin
  if auth.uid() is null then raise exception '請先登入'; end if;
  select json_build_object(
    'code', upper(substr(md5(p_seller::text), 1, 4)),
    'avg', (select round(avg(stars)::numeric, 1) from public.ratings where seller_id = p_seller),
    'cnt', (select count(*) from public.ratings where seller_id = p_seller),
    'deals', (select count(*) from public.threads where seller_id = p_seller and status = 'completed' and book_id is not null),
    'active', (select count(*) from public.books where seller_id = p_seller and status in ('active', 'reserved')),
    'sold', (select count(*) from public.books where seller_id = p_seller and status = 'sold'),
    'reviews', coalesce((select json_agg(x) from (select stars, comment, created_at from public.ratings where seller_id = p_seller order by created_at desc limit 10) x), '[]'::json)
  ) into r;
  return r;
end $$;
revoke all on function public.seller_stats(uuid) from public, anon;
grant execute on function public.seller_stats(uuid) to authenticated;

-- ============ 4. 搜尋紀錄(營運分析用,不記錄是誰搜的)============
create table if not exists public.search_logs (
  id bigint generated always as identity primary key,
  q text not null check (char_length(q) between 1 and 60),
  found integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists search_logs_created_idx on public.search_logs (created_at desc);
alter table public.search_logs enable row level security;   -- 沒有任何 policy:只能透過下面的函式寫入、管理員統計函式讀取
create or replace function public.log_search(p_q text, p_found integer) returns void
language plpgsql security definer set search_path = public as $$
declare v_q text := left(lower(btrim(coalesce(p_q, ''))), 60);
begin
  if char_length(v_q) < 2 then return; end if;
  -- 同一個關鍵字最近一分鐘已記錄過就略過
  if exists (select 1 from public.search_logs s where s.q = v_q and s.created_at > now() - interval '1 minute') then return; end if;
  insert into public.search_logs (q, found) values (v_q, greatest(0, coalesce(p_found, 0)));
end $$;
revoke all on function public.log_search(text, integer) from public;
grant execute on function public.log_search(text, integer) to anon, authenticated;

-- ============ 5. 管理員分級 ============
alter table public.admins add column if not exists role text not null default 'super';
do $$ begin
  alter table public.admins add constraint admins_role_check check (role in ('super', 'moderator', 'viewer'));
exception when duplicate_object then null; end $$;
create or replace function public.admin_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.admins where user_id = auth.uid()
$$;
grant execute on function public.admin_role() to authenticated;

-- 所有會寫入「處置紀錄」的管理動作都先過這道檢查:
--   viewer(唯讀)一律不行;重設密碼、測試帳號、調整管理員權限只有 super 可以
create or replace function public.moderation_log_guard() returns trigger language plpgsql security definer set search_path = public as $$
declare rl text;
begin
  if auth.uid() is null then return new; end if;           -- 系統(service role)寫入不受限
  rl := public.admin_role();
  if rl is null then return new; end if;                   -- 非管理員不會走到這裡(RPC 自己會擋)
  if rl = 'viewer' then raise exception '唯讀管理員不能執行這個操作'; end if;
  if new.action in ('reset_password', 'test_account', 'role_change') and rl <> 'super' then raise exception '只有最高權限管理員可以執行這個操作'; end if;
  return new;
end $$;
drop trigger if exists moderation_log_guard on public.moderation_log;
create trigger moderation_log_guard before insert on public.moderation_log for each row execute function public.moderation_log_guard();

-- 公告與面交地點:只有 super / moderator 能改(viewer 只能看)
drop policy if exists announcements_admin on public.announcements;
create policy announcements_admin on public.announcements for all to authenticated
  using (public.admin_role() in ('super', 'moderator')) with check (public.admin_role() in ('super', 'moderator'));
drop policy if exists meetup_places_admin on public.meetup_places;
create policy meetup_places_admin on public.meetup_places for all to authenticated
  using (public.admin_role() in ('super', 'moderator')) with check (public.admin_role() in ('super', 'moderator'));

create or replace function public.admin_list_admins() returns table(user_id uuid, display_name text, role text)
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception '沒有權限'; end if;
  return query select a.user_id, p.display_name, a.role from public.admins a left join public.profiles p on p.id = a.user_id order by a.role, p.display_name;
end $$;
revoke all on function public.admin_list_admins() from public, anon;
grant execute on function public.admin_list_admins() to authenticated;

create or replace function public.admin_set_role(p_user uuid, p_role text) returns void
language plpgsql security definer set search_path = public as $$
declare nm text;
begin
  if public.admin_role() is distinct from 'super' then raise exception '只有最高權限管理員可以調整權限'; end if;
  if p_role not in ('super', 'moderator', 'viewer', 'none') then raise exception '角色不正確'; end if;
  if p_user = auth.uid() and p_role <> 'super' then raise exception '不能降低自己的權限(請讓另一位最高權限管理員來調整)'; end if;
  select display_name into nm from public.profiles where id = p_user;
  if nm is null then raise exception '找不到這位使用者'; end if;
  if p_role = 'none' then delete from public.admins where user_id = p_user;
  else insert into public.admins (user_id, role) values (p_user, p_role) on conflict (user_id) do update set role = excluded.role; end if;
  insert into public.moderation_log (admin_id, target_type, target_id, target_title, action, reason)
    values (auth.uid(), 'user', p_user::text, nm, 'role_change', '權限改為:' || p_role);
end $$;
revoke all on function public.admin_set_role(uuid, text) from public, anon;
grant execute on function public.admin_set_role(uuid, text) to authenticated;

-- 重設密碼、測試帳號:寫入處置紀錄(同時受上面的 super 限制)
create or replace function public.admin_prepare_test_account() returns table(email text, password text)
language plpgsql security definer set search_path = public, auth, extensions as $$
declare
  em constant text := 'test.student@example.com';
  uid uuid;
  pw text := 'Test' || substr(encode(gen_random_bytes(8), 'hex'), 1, 8) || '9';
  ver text;
begin
  if not public.is_admin() then raise exception '沒有權限'; end if;
  insert into public.moderation_log (admin_id, target_type, target_id, target_title, action, reason)
    values (auth.uid(), 'user', 'test', '測試同學', 'test_account', '管理員切換成測試同學');
  select id into uid from auth.users where lower(auth.users.email) = em;
  if uid is null then
    uid := gen_random_uuid();
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                            created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change)
    values ('00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated', em, crypt(pw, gen_salt('bf', 10)), now(),
            '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '');
    insert into auth.identities (id, user_id, provider, provider_id, identity_data, created_at, updated_at, last_sign_in_at)
    values (gen_random_uuid(), uid, 'email', em, jsonb_build_object('sub', uid::text, 'email', em, 'email_verified', true), now(), now(), now());
    insert into public.profiles (id, display_name) values (uid, '測試同學');
    insert into public.user_private (user_id, line_user_id, department, name_set, real_name, enroll_year, student_verified, verified_at, verify_status, own_login_set, own_login_at)
    values (uid, 'test_account', '護理系', true, '測試同學', 113, true, now(), 'approved', true, now());
  else
    update auth.users set encrypted_password = crypt(pw, gen_salt('bf', 10)), updated_at = now() where id = uid;
    update public.user_private set student_verified = true, verify_status = 'approved', own_login_set = true, name_set = true, own_login_at = now() where user_id = uid;
    update public.profiles set banned = false where id = uid;
  end if;
  select value into ver from public.app_settings where key = 'terms_version';
  insert into public.consents (user_id, version, signed_name) values (uid, ver, '測試同學') on conflict do nothing;
  return query select em, pw;
end $$;
revoke all on function public.admin_prepare_test_account() from public, anon;
grant execute on function public.admin_prepare_test_account() to authenticated;

-- ============ 6. 營運統計(管理員專用)============
create or replace function public.admin_stats() returns json
language plpgsql stable security definer set search_path = public as $$
declare r json;
begin
  if not public.is_admin() then raise exception '沒有權限'; end if;
  select json_build_object(
    'users', (select count(*) from public.profiles),
    'verified', (select count(*) from public.user_private where student_verified),
    'books_total', (select count(*) from public.books where status <> 'hidden'),
    'books_active', (select count(*) from public.books where status = 'active'),
    'books_sold', (select count(*) from public.books where status = 'sold'),
    'wishes_active', (select count(*) from public.wishes where status = 'active'),
    'threads', (select count(*) from public.threads where book_id is not null),
    'deals', (select count(*) from public.threads where book_id is not null and status = 'completed'),
    'favorites', (select count(*) from public.favorites),
    'by_month', coalesce((select json_agg(x order by x.m) from (
        select to_char(m, 'YYYY-MM') as m,
               (select count(*) from public.profiles p where date_trunc('month', p.created_at) = m) as users,
               (select count(*) from public.books b where date_trunc('month', b.created_at) = m) as books,
               (select count(*) from public.threads t where t.book_id is not null and t.status = 'completed' and date_trunc('month', t.updated_at) = m) as deals
        from generate_series(date_trunc('month', now()) - interval '5 months', date_trunc('month', now()), interval '1 month') m) x), '[]'::json),
    'dept_books', coalesce((select json_agg(x) from (select course_dept as name, count(*) as cnt from public.books where status <> 'hidden' and course_dept <> '' group by 1 order by 2 desc limit 8) x), '[]'::json),
    'top_courses', coalesce((select json_agg(x) from (select course as name, count(*) as cnt from public.books where status <> 'hidden' and course <> '' group by 1 order by 2 desc limit 8) x), '[]'::json),
    'top_teachers', coalesce((select json_agg(x) from (select teacher as name, count(*) as cnt from public.books where status <> 'hidden' and teacher <> '' group by 1 order by 2 desc limit 8) x), '[]'::json),
    'top_favorited', coalesce((select json_agg(x) from (select b.title as name, count(*) as cnt from public.favorites f join public.books b on b.id = f.book_id group by b.title order by 2 desc limit 8) x), '[]'::json),
    'top_wishes', coalesce((select json_agg(x) from (select lower(title) as name, count(*) as cnt from public.wishes group by 1 order by 2 desc limit 8) x), '[]'::json),
    'top_searches', coalesce((select json_agg(x) from (select q as name, count(*) as cnt from public.search_logs where created_at > now() - interval '60 days' group by 1 order by 2 desc limit 10) x), '[]'::json),
    'zero_searches', coalesce((select json_agg(x) from (select q as name, count(*) as cnt from public.search_logs where search_logs.found = 0 and created_at > now() - interval '60 days' group by 1 order by 2 desc limit 10) x), '[]'::json)
  ) into r;
  return r;
end $$;
revoke all on function public.admin_stats() from public, anon;
grant execute on function public.admin_stats() to authenticated;

-- ============ 7. 刪除自己的帳號與個資 ============
create or replace function public.delete_my_account() returns void
language plpgsql security definer set search_path = public, auth as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception '請先登入'; end if;
  if exists (select 1 from public.admins where user_id = uid) then raise exception '管理員帳號請先由最高權限管理員取消管理員身分,再刪除'; end if;
  -- 進行中的交易先取消,避免對方卡住
  update public.threads set status = 'cancelled', updated_at = now() where (buyer_id = uid or seller_id = uid) and status in ('open', 'accepted');
  -- 刪除使用者:個人資料、書籍、許願、收藏、評價、聊天室等都會連帶刪除(聊天訊息中他的發言者會變成匿名)
  delete from auth.users where id = uid;
end $$;
revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

-- ============ 8. 權限收緊(RLS 之外再加一層保險)============
-- 前台未登入的訪客只需要讀「書、許願、公告、面交地點、同意書版本」,其他資料表一律不給訪客碰
revoke all on all tables in schema public from anon;
grant select on public.books, public.wishes, public.announcements, public.meetup_places, public.app_settings to anon;
-- 登入的使用者也不需要 TRUNCATE / TRIGGER / REFERENCES
revoke truncate, trigger, references on all tables in schema public from anon, authenticated;
