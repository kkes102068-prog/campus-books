-- 老師建議的新功能(2026-11)
--   在校生驗證(學校 Email 驗證碼)、檢舉、賣家評價、交易地點限制、停權原因、管理員帳號密碼登入
-- 可重複執行;只新增資料表、欄位與函式,不會刪除任何使用者資料。
-- 執行順序:先前的 SQL(schema.sql、全部新增SQL)都已執行後,再貼這一份到 Supabase → SQL Editor。

-- ============ 1. 在校生驗證 ============
alter table public.user_private add column if not exists school_email text not null default '';
alter table public.user_private add column if not exists student_verified boolean not null default false;
alter table public.user_private add column if not exists verified_at timestamptz;
create unique index if not exists user_private_school_email_uniq
  on public.user_private (lower(school_email)) where school_email <> '';

create table if not exists public.email_verifications (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  email         text not null,
  code_hash     text not null,
  expires_at    timestamptz not null,
  attempts      integer not null default 0,
  last_sent_at  timestamptz not null default now(),
  window_start  timestamptz not null default now(),
  sent_in_window integer not null default 1
);
alter table public.email_verifications enable row level security;   -- 不開任何 policy:前端不能直接讀寫

-- 只有已驗證的在校生(或管理員)才算「可用的使用者」:所有上架、許願、聊聊、購買都靠這個函式把關
create or replace function public.is_active_user() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p join public.user_private u on u.user_id = p.id
                 where p.id = auth.uid() and not p.banned and u.department <> ''
                   and (u.student_verified or exists (select 1 from public.admins a where a.user_id = p.id))
                   and exists (select 1 from public.consents c
                               where c.user_id = p.id
                                 and c.version = (select value from public.app_settings where key = 'terms_version')))
$$;

-- 以下兩個函式只給 Edge Function(service_role)呼叫:寄驗證碼前登記、使用者輸入後檢查
create or replace function public.put_email_code(p_user uuid, p_email text, p_hash text) returns text
language plpgsql security definer set search_path = public as $$
declare ev public.email_verifications;
begin
  p_email := lower(btrim(p_email));
  if exists (select 1 from public.user_private where lower(school_email) = p_email and user_id <> p_user) then return 'taken'; end if;
  select * into ev from public.email_verifications where user_id = p_user;
  if found then
    if ev.last_sent_at > now() - interval '60 seconds' then return 'cooldown'; end if;
    if ev.window_start > now() - interval '24 hours' and ev.sent_in_window >= 5 then return 'daily'; end if;
  end if;
  insert into public.email_verifications (user_id, email, code_hash, expires_at, attempts, last_sent_at, window_start, sent_in_window)
    values (p_user, p_email, p_hash, now() + interval '10 minutes', 0, now(), now(), 1)
  on conflict (user_id) do update set
    email = excluded.email, code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, last_sent_at = now(),
    window_start = case when public.email_verifications.window_start > now() - interval '24 hours'
                        then public.email_verifications.window_start else now() end,
    sent_in_window = case when public.email_verifications.window_start > now() - interval '24 hours'
                          then public.email_verifications.sent_in_window + 1 else 1 end;
  return 'ok';
end $$;

create or replace function public.check_email_code(p_user uuid, p_hash text) returns text
language plpgsql security definer set search_path = public as $$
declare ev public.email_verifications;
begin
  select * into ev from public.email_verifications where user_id = p_user;
  if not found then return 'none'; end if;
  if ev.attempts >= 5 then return 'locked'; end if;
  if ev.expires_at < now() then return 'expired'; end if;
  if ev.code_hash <> p_hash then
    update public.email_verifications set attempts = attempts + 1 where user_id = p_user;
    return 'invalid';
  end if;
  if exists (select 1 from public.user_private where lower(school_email) = lower(ev.email) and user_id <> p_user) then return 'taken'; end if;
  update public.user_private set school_email = ev.email, student_verified = true, verified_at = now() where user_id = p_user;
  delete from public.email_verifications where user_id = p_user;
  return 'ok';
end $$;

revoke all on function public.put_email_code(uuid, text, text) from public, anon, authenticated;
revoke all on function public.check_email_code(uuid, text) from public, anon, authenticated;
grant execute on function public.put_email_code(uuid, text, text) to service_role;
grant execute on function public.check_email_code(uuid, text) to service_role;

-- 沒有學校信箱的同學,管理員可手動核准 / 取消
create or replace function public.admin_set_verified(p_user uuid, p_ok boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception '沒有權限'; end if;
  update public.user_private set student_verified = p_ok, verified_at = case when p_ok then now() else null end where user_id = p_user;
  insert into public.moderation_log (admin_id, target_type, target_id, target_title, action, reason)
    select auth.uid(), 'user', p_user::text, coalesce((select display_name from public.profiles where id = p_user), ''),
           case when p_ok then 'verify' else 'unverify' end, '管理員手動操作';
end $$;
revoke all on function public.admin_set_verified(uuid, boolean) from public, anon;
grant execute on function public.admin_set_verified(uuid, boolean) to authenticated;

-- ============ 2. 停權原因與強制剔除 ============
alter table public.profiles add column if not exists ban_reason text not null default '';
alter table public.profiles add column if not exists banned_at timestamptz;

-- 停權:帳號立刻失效;他的上架書籍下架、進行中的交易取消;原因會顯示給本人
create or replace function public.admin_set_ban(p_user uuid, p_ban boolean, p_reason text default '') returns void
language plpgsql security definer set search_path = public as $$
declare r text := left(coalesce(btrim(p_reason), ''), 300); nm text;
begin
  if not public.is_admin() then raise exception '沒有權限'; end if;
  if exists (select 1 from public.admins where user_id = p_user) then raise exception '不能停權管理員'; end if;
  select display_name into nm from public.profiles where id = p_user;
  if not found then raise exception '找不到這位使用者'; end if;

  if p_ban then
    update public.profiles set banned = true, ban_reason = r, banned_at = now() where id = p_user;
    update public.books set status = 'hidden' where seller_id = p_user and status in ('active', 'reserved');
    insert into public.messages (thread_id, sender_id, body, is_system)
      select id, auth.uid(), '對方帳號已被管理員停權,這筆交易已取消。', true
      from public.threads where (buyer_id = p_user or seller_id = p_user) and status in ('open', 'accepted');
    update public.threads set status = 'cancelled', updated_at = now()
      where (buyer_id = p_user or seller_id = p_user) and status in ('open', 'accepted');
  else
    update public.profiles set banned = false, ban_reason = '', banned_at = null where id = p_user;
  end if;

  insert into public.moderation_log (admin_id, target_type, target_id, target_title, action, reason)
    values (auth.uid(), 'user', p_user::text, coalesce(nm, ''), case when p_ban then 'ban' else 'unban' end, r);
end $$;
revoke all on function public.admin_set_ban(uuid, boolean, text) from public, anon;
grant execute on function public.admin_set_ban(uuid, boolean, text) to authenticated;

-- ============ 3. 檢舉 ============
create table if not exists public.reports (
  id             bigint generated always as identity primary key,
  reporter_id    uuid not null references public.profiles(id) on delete cascade,
  target_type    text not null check (target_type in ('book', 'user')),
  book_id        uuid references public.books(id) on delete set null,
  target_user_id uuid not null references public.profiles(id) on delete cascade,
  reason         text not null check (reason in ('irrelevant', 'fraud', 'harassment', 'illegal', 'other')),
  detail         text not null default '' check (char_length(detail) <= 300),
  status         text not null default 'open' check (status in ('open', 'actioned', 'dismissed')),
  handled_by     uuid references public.profiles(id) on delete set null,
  handled_at     timestamptz,
  handled_note   text not null default '' check (char_length(handled_note) <= 300),
  created_at     timestamptz not null default now()
);
create index if not exists reports_status_idx on public.reports (status, created_at desc);
create index if not exists reports_target_idx on public.reports (target_user_id);
create unique index if not exists reports_open_book_uniq on public.reports (reporter_id, book_id) where status = 'open' and book_id is not null;
create unique index if not exists reports_open_user_uniq on public.reports (reporter_id, target_user_id) where status = 'open' and target_type = 'user';
alter table public.reports enable row level security;
drop policy if exists reports_admin_read on public.reports;
create policy reports_admin_read on public.reports for select to authenticated using (public.is_admin());
drop policy if exists reports_own_read on public.reports;
create policy reports_own_read on public.reports for select to authenticated using (reporter_id = auth.uid());

create or replace function public.report_book(p_book uuid, p_reason text, p_detail text default '') returns void
language plpgsql security definer set search_path = public as $$
declare b public.books;
begin
  if auth.uid() is null or not public.is_active_user() then raise exception '請先登入並完成註冊'; end if;
  select * into b from public.books where id = p_book;
  if not found then raise exception '找不到這本書'; end if;
  if b.seller_id = auth.uid() then raise exception '不能檢舉自己的書'; end if;
  if (select count(*) from public.reports where reporter_id = auth.uid() and created_at > now() - interval '24 hours') >= 10 then
    raise exception '今天檢舉的次數太多了,請明天再試';
  end if;
  begin
    insert into public.reports (reporter_id, target_type, book_id, target_user_id, reason, detail)
      values (auth.uid(), 'book', p_book, b.seller_id, p_reason, left(coalesce(btrim(p_detail), ''), 300));
  exception when unique_violation then raise exception '你已經檢舉過這本書,管理員處理中';
  end;
end $$;

create or replace function public.report_thread_user(p_thread uuid, p_reason text, p_detail text default '') returns void
language plpgsql security definer set search_path = public as $$
declare t public.threads; other uuid;
begin
  if auth.uid() is null or not public.is_active_user() then raise exception '請先登入並完成註冊'; end if;
  select * into t from public.threads where id = p_thread;
  if not found or not (t.buyer_id = auth.uid() or t.seller_id = auth.uid()) then raise exception '找不到這串聊聊'; end if;
  other := case when t.buyer_id = auth.uid() then t.seller_id else t.buyer_id end;
  if exists (select 1 from public.admins where user_id = other) then raise exception '這是管理員,不能檢舉'; end if;
  if (select count(*) from public.reports where reporter_id = auth.uid() and created_at > now() - interval '24 hours') >= 10 then
    raise exception '今天檢舉的次數太多了,請明天再試';
  end if;
  begin
    insert into public.reports (reporter_id, target_type, book_id, target_user_id, reason, detail)
      values (auth.uid(), 'user', t.book_id, other, p_reason, left(coalesce(btrim(p_detail), ''), 300));
  exception when unique_violation then raise exception '你已經檢舉過這位使用者,管理員處理中';
  end;
end $$;

-- 管理員處理檢舉:takedown = 下架被檢舉的書;ban = 停權被檢舉的人;dismiss = 駁回
create or replace function public.resolve_report(p_report bigint, p_action text, p_note text default '') returns void
language plpgsql security definer set search_path = public as $$
declare rp public.reports; n text := left(coalesce(btrim(p_note), ''), 300);
begin
  if not public.is_admin() then raise exception '沒有權限'; end if;
  select * into rp from public.reports where id = p_report;
  if not found then raise exception '找不到這筆檢舉'; end if;
  if p_action = 'takedown' then
    if rp.book_id is null then raise exception '這筆檢舉沒有對應的書'; end if;
    perform public.admin_set_book_hidden(rp.book_id, true, coalesce(nullif(n, ''), '被檢舉:' || rp.reason));
  elsif p_action = 'ban' then
    perform public.admin_set_ban(rp.target_user_id, true, coalesce(nullif(n, ''), '被檢舉:' || rp.reason));
  elsif p_action <> 'dismiss' then
    raise exception '不支援的處理方式';
  end if;
  update public.reports set status = case when p_action = 'dismiss' then 'dismissed' else 'actioned' end,
         handled_by = auth.uid(), handled_at = now(), handled_note = n
   where status = 'open' and (id = p_report or (target_user_id = rp.target_user_id and (p_action <> 'takedown' or book_id = rp.book_id)));
end $$;

revoke all on function public.report_book(uuid, text, text), public.report_thread_user(uuid, text, text), public.resolve_report(bigint, text, text) from public, anon;
grant execute on function public.report_book(uuid, text, text) to authenticated;
grant execute on function public.report_thread_user(uuid, text, text) to authenticated;
grant execute on function public.resolve_report(bigint, text, text) to authenticated;

-- ============ 4. 賣家評價(滿意度 / 信用) ============
create table if not exists public.ratings (
  thread_id  uuid primary key references public.threads(id) on delete cascade,
  seller_id  uuid not null references public.profiles(id) on delete cascade,
  rater_id   uuid not null references public.profiles(id) on delete cascade,
  stars      smallint not null check (stars between 1 and 5),
  comment    text not null default '' check (char_length(comment) <= 100),
  created_at timestamptz not null default now()
);
create index if not exists ratings_seller_idx on public.ratings (seller_id);
alter table public.ratings enable row level security;
drop policy if exists ratings_read on public.ratings;
create policy ratings_read on public.ratings for select to authenticated
  using (rater_id = auth.uid() or seller_id = auth.uid() or public.is_admin());

-- 只有「已完成交易」的買家,才能對賣家評價一次
create or replace function public.rate_seller(p_thread uuid, p_stars integer, p_comment text default '') returns void
language plpgsql security definer set search_path = public as $$
declare t public.threads;
begin
  if auth.uid() is null or not public.is_active_user() then raise exception '請先登入並完成註冊'; end if;
  select * into t from public.threads where id = p_thread;
  if not found or t.buyer_id <> auth.uid() then raise exception '只有這筆交易的買家可以評價'; end if;
  if t.kind <> 'trade' or t.status <> 'completed' then raise exception '交易完成後才能評價'; end if;
  if p_stars not between 1 and 5 then raise exception '請選擇 1 到 5 顆星'; end if;
  begin
    insert into public.ratings (thread_id, seller_id, rater_id, stars, comment)
      values (p_thread, t.seller_id, auth.uid(), p_stars, left(coalesce(btrim(p_comment), ''), 100));
  exception when unique_violation then raise exception '這筆交易已經評價過了';
  end;
end $$;

-- 公開的平均星數(依書列出,不透露賣家是誰)
create or replace function public.book_seller_ratings() returns table (book_id uuid, avg_stars numeric, cnt integer)
language sql stable security definer set search_path = public as $$
  select b.id, round(avg(r.stars)::numeric, 1), count(*)::integer
  from public.books b join public.ratings r on r.seller_id = b.seller_id
  where b.status in ('active', 'reserved', 'sold')
  group by b.id
$$;

create or replace function public.my_rating() returns table (avg_stars numeric, cnt integer)
language sql stable security definer set search_path = public as $$
  select round(avg(stars)::numeric, 1), count(*)::integer from public.ratings where seller_id = auth.uid()
$$;

revoke all on function public.rate_seller(uuid, integer, text), public.my_rating() from public, anon;
grant execute on function public.rate_seller(uuid, integer, text) to authenticated;
grant execute on function public.my_rating() to authenticated;
grant execute on function public.book_seller_ratings() to anon, authenticated;

-- ============ 5. 交易地點限制 ============
create table if not exists public.meetup_places (
  id     bigint generated always as identity primary key,
  name   text not null unique check (char_length(name) between 1 and 40),
  sort   integer not null default 0,
  active boolean not null default true
);
alter table public.meetup_places enable row level security;
drop policy if exists meetup_places_read on public.meetup_places;
create policy meetup_places_read on public.meetup_places for select to anon, authenticated using (active or public.is_admin());
drop policy if exists meetup_places_admin on public.meetup_places;
create policy meetup_places_admin on public.meetup_places for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- 範例清單:請到後台「交易地點」改成北護真實的地點
insert into public.meetup_places (name, sort) values
  ('圖書館門口', 1), ('學生餐廳', 2), ('各系館一樓大廳', 3), ('校門口警衛室', 4)
on conflict (name) do nothing;

-- 面交地點只能是清單裡的地點(上架時)
create or replace function public.check_book_meetup_place() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.allow_meetup and (tg_op = 'INSERT' or new.meetup_place is distinct from old.meetup_place or new.allow_meetup is distinct from old.allow_meetup) then
    if not exists (select 1 from public.meetup_places where name = new.meetup_place and active) then
      raise exception '面交地點必須從清單中選擇';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists books_check_meetup_place on public.books;
create trigger books_check_meetup_place before insert or update on public.books
  for each row execute function public.check_book_meetup_place();

-- 聊聊裡的「約定面交」卡片,地點也只能是清單裡的地點
create or replace function public.check_message_meetup_place() returns trigger
language plpgsql security definer set search_path = public as $$
declare place text;
begin
  if not new.is_system and new.body like '📍【面交約定】%' then
    place := btrim(substring(new.body from '地點:([^' || chr(10) || ']*)'));
    if place is null or not exists (select 1 from public.meetup_places where name = place and active) then
      raise exception '面交地點必須從清單中選擇';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists messages_check_meetup_place on public.messages;
create trigger messages_check_meetup_place before insert on public.messages
  for each row execute function public.check_message_meetup_place();

-- ============ 6. 管理員用帳號密碼登入 ============
-- 作法:先到 Supabase → Authentication → Users → Add user → Create new user(填 Email 與密碼,勾選 Auto Confirm),
-- 再在 SQL Editor 執行:  select public.make_admin_account('你的管理員Email', '管理員');
create or replace function public.make_admin_account(p_email text, p_name text default '管理員') returns text
language plpgsql security definer set search_path = public, auth as $$
declare uid uuid;
begin
  select id into uid from auth.users where lower(email) = lower(btrim(p_email));
  if uid is null then return '找不到這個 Email 的帳號,請先到 Authentication → Users 新增使用者'; end if;
  insert into public.profiles (id, display_name) values (uid, left(p_name, 100)) on conflict (id) do nothing;
  insert into public.user_private (user_id, line_user_id, department, student_verified, verified_at)
    values (uid, 'admin:' || uid::text, '管理員', true, now())
    on conflict (user_id) do update set student_verified = true;
  insert into public.admins (user_id) values (uid) on conflict (user_id) do nothing;
  return '完成:' || p_email || ' 已設為管理員,可到後台用 Email 與密碼登入';
end $$;
revoke all on function public.make_admin_account(text, text) from public, anon, authenticated;

-- 後台以帳號密碼登入後,記錄這次登入(讓「登入紀錄」包含管理員)
create or replace function public.log_my_login() returns void
language plpgsql security definer set search_path = public as $$
declare h json; ip text := ''; ua text := '';
begin
  if auth.uid() is null then return; end if;
  begin
    h := current_setting('request.headers', true)::json;
    ip := coalesce(split_part(h ->> 'x-forwarded-for', ',', 1), '');
    ua := left(coalesce(h ->> 'user-agent', ''), 300);
  exception when others then null;
  end;
  insert into public.login_logs (user_id, ip, user_agent) values (auth.uid(), btrim(ip), '[帳密登入] ' || ua);
  update public.user_private set last_login_at = now(), login_count = login_count + 1 where user_id = auth.uid();
end $$;
revoke all on function public.log_my_login() from public, anon;
grant execute on function public.log_my_login() to authenticated;
