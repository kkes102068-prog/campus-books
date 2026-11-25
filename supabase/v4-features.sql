-- v4:學期與課程教材資料庫、交易爭議處理、通知中心
-- 在 Supabase SQL Editor 貼上執行(可重複執行)。需先執行 v3-features.sql。

-- ============ 1. 學期、課程、課程教材 ============
create table if not exists public.semesters (
  id         integer generated always as identity primary key,
  name       text not null unique check (char_length(name) between 3 and 20),   -- 例:114-1
  start_date date not null,
  end_date   date not null,
  check (end_date > start_date)
);
create table if not exists public.courses (
  id          bigint generated always as identity primary key,
  semester_id integer not null references public.semesters(id) on delete cascade,
  dept        text not null check (char_length(dept) between 1 and 60),
  name        text not null check (char_length(name) between 1 and 60),
  teacher     text not null default '' check (char_length(teacher) <= 60),
  unique (semester_id, dept, name, teacher)
);
create table if not exists public.course_textbooks (
  id        bigint generated always as identity primary key,
  course_id bigint not null references public.courses(id) on delete cascade,
  title     text not null check (char_length(title) between 1 and 100),
  isbn      text not null default '' check (char_length(isbn) <= 17),
  required  boolean not null default true,
  note      text not null default '' check (char_length(note) <= 100),
  unique (course_id, title)
);
create index if not exists courses_sem_idx on public.courses (semester_id, dept);
create index if not exists textbooks_course_idx on public.course_textbooks (course_id);
alter table public.semesters enable row level security;
alter table public.courses enable row level security;
alter table public.course_textbooks enable row level security;
do $$ declare t text; begin
  foreach t in array array['semesters', 'courses', 'course_textbooks'] loop
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('create policy %I on public.%I for select to anon, authenticated using (true)', t || '_read', t);
    execute format('drop policy if exists %I on public.%I', t || '_admin', t);
    execute format('create policy %I on public.%I for all to authenticated using (public.admin_role() in (''super'', ''moderator'')) with check (public.admin_role() in (''super'', ''moderator''))', t || '_admin', t);
    execute format('grant select on public.%I to anon', t);
  end loop;
end $$;

-- 目前學期:今天落在哪個學期的日期範圍內(學期自動切換);都不在時用最近結束的那個
create or replace function public.current_semester() returns integer
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select id from public.semesters where current_date between start_date and end_date order by start_date desc limit 1),
    (select id from public.semesters order by end_date desc limit 1))
$$;
grant execute on function public.current_semester() to anon, authenticated;

-- ============ 2. 通知中心 ============
create table if not exists public.notifications (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  kind       text not null check (kind in ('price_drop', 'wish_match', 'trade', 'dispute', 'system')),
  title      text not null check (char_length(title) <= 80),
  body       text not null default '' check (char_length(body) <= 200),
  link       text not null default '' check (char_length(link) <= 120),
  read_at    timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);
alter table public.notifications enable row level security;
drop policy if exists notifications_own_read on public.notifications;
create policy notifications_own_read on public.notifications for select to authenticated using (user_id = auth.uid());
drop policy if exists notifications_own_delete on public.notifications;
create policy notifications_own_delete on public.notifications for delete to authenticated using (user_id = auth.uid());

create table if not exists public.notification_prefs (
  user_id    uuid primary key references public.profiles(id) on delete cascade,
  price_drop boolean not null default true,
  wish_match boolean not null default true,
  trade      boolean not null default true,
  dispute    boolean not null default true
);
alter table public.notification_prefs enable row level security;
drop policy if exists notification_prefs_own on public.notification_prefs;
create policy notification_prefs_own on public.notification_prefs for select to authenticated using (user_id = auth.uid());

-- 內部函式:寫入一則通知(會檢查對方的通知偏好、24 小時內相同內容不重複、每人只留最新 100 則)
create or replace function public.notify_user(p_user uuid, p_kind text, p_title text, p_body text, p_link text) returns void
language plpgsql security definer set search_path = public as $$
declare ok boolean := true;
begin
  if p_user is null then return; end if;
  if p_kind in ('price_drop', 'wish_match', 'trade', 'dispute') then
    execute format('select coalesce((select %I from public.notification_prefs where user_id = $1), true)', p_kind) into ok using p_user;
  end if;
  if not ok then return; end if;
  if exists (select 1 from public.notifications where user_id = p_user and kind = p_kind and title = left(p_title, 80) and link = left(p_link, 120) and created_at > now() - interval '24 hours') then return; end if;
  insert into public.notifications (user_id, kind, title, body, link) values (p_user, p_kind, left(p_title, 80), left(coalesce(p_body, ''), 200), left(coalesce(p_link, ''), 120));
  delete from public.notifications where user_id = p_user and id not in (select id from public.notifications where user_id = p_user order by created_at desc, id desc limit 100);
end $$;
revoke all on function public.notify_user(uuid, text, text, text, text) from public, anon, authenticated;

create or replace function public.mark_notifications_read(p_ids bigint[] default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception '請先登入'; end if;
  update public.notifications set read_at = now() where user_id = auth.uid() and read_at is null and (p_ids is null or id = any(p_ids));
end $$;
revoke all on function public.mark_notifications_read(bigint[]) from public, anon;
grant execute on function public.mark_notifications_read(bigint[]) to authenticated;

create or replace function public.set_notification_pref(p_kind text, p_on boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception '請先登入'; end if;
  if p_kind not in ('price_drop', 'wish_match', 'trade', 'dispute') then raise exception '通知類型不正確'; end if;
  insert into public.notification_prefs (user_id) values (auth.uid()) on conflict (user_id) do nothing;
  execute format('update public.notification_prefs set %I = $1 where user_id = $2', p_kind) using coalesce(p_on, true), auth.uid();
end $$;
revoke all on function public.set_notification_pref(text, boolean) from public, anon;
grant execute on function public.set_notification_pref(text, boolean) to authenticated;

-- 觸發:收藏的書降價
create or replace function public.trg_book_price_drop() returns trigger language plpgsql security definer set search_path = public as $$
declare f record;
begin
  if new.price < old.price and new.status = 'active' then
    for f in select user_id from public.favorites where book_id = new.id and user_id <> new.seller_id loop
      perform public.notify_user(f.user_id, 'price_drop', '《' || new.title || '》降價到 NT$ ' || new.price, '你收藏的書從 NT$ ' || old.price || ' 降價了', '?book=' || new.id);
    end loop;
  end if;
  return new;
end $$;
drop trigger if exists book_price_drop on public.books;
create trigger book_price_drop after update of price on public.books for each row execute function public.trg_book_price_drop();

-- 觸發:有人上架符合許願的書
create or replace function public.trg_book_wish_match() returns trigger language plpgsql security definer set search_path = public as $$
declare w record; a text := lower(regexp_replace(new.title, '\s+', '', 'g')); b text;
begin
  if new.status <> 'active' then return new; end if;
  for w in select user_id, title from public.wishes where status = 'active' and user_id <> new.seller_id loop
    b := lower(regexp_replace(w.title, '\s+', '', 'g'));
    if char_length(b) >= 2 and (position(b in a) > 0 or position(a in b) > 0) then
      perform public.notify_user(w.user_id, 'wish_match', '你許願的書有人上架了', '《' || new.title || '》NT$ ' || new.price, '?book=' || new.id);
    end if;
  end loop;
  return new;
end $$;
drop trigger if exists book_wish_match on public.books;
create trigger book_wish_match after insert on public.books for each row execute function public.trg_book_wish_match();

-- 觸發:交易有新進度(通知「對方」)
create or replace function public.trg_thread_notify() returns trigger language plpgsql security definer set search_path = public as $$
declare other uuid; ttl text; lbl text;
begin
  if (new.buyer_id = auth.uid()) then other := new.seller_id; else other := new.buyer_id; end if;
  if other is null or other = auth.uid() then return new; end if;
  select title into ttl from public.books where id = new.book_id;
  if tg_op = 'INSERT' then
    perform public.notify_user(other, 'trade', case when new.book_id is not null then '有同學想買你的書' else '有人回應了你的許願' end, coalesce('《' || ttl || '》', ''), '?thread=' || new.id);
  elsif new.status is distinct from old.status then
    lbl := case new.status when 'accepted' then '交易已確認' when 'completed' then '交易已完成' when 'cancelled' then '交易已取消' else '交易狀態更新' end;
    perform public.notify_user(other, 'trade', lbl, coalesce('《' || ttl || '》', ''), '?thread=' || new.id);
  end if;
  return new;
end $$;
drop trigger if exists thread_notify_ins on public.threads;
create trigger thread_notify_ins after insert on public.threads for each row execute function public.trg_thread_notify();
drop trigger if exists thread_notify_upd on public.threads;
create trigger thread_notify_upd after update of status on public.threads for each row execute function public.trg_thread_notify();

-- ============ 3. 交易爭議 ============
create table if not exists public.transaction_disputes (
  id          bigint generated always as identity primary key,
  thread_id   uuid not null references public.threads(id) on delete cascade,
  reporter_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  reason      text not null check (reason in ('no_show', 'condition', 'price', 'harassment', 'other')),
  detail      text not null default '' check (char_length(detail) <= 500),
  status      text not null default 'open' check (status in ('open', 'investigating', 'resolved', 'dismissed')),
  admin_note  text not null default '' check (char_length(admin_note) <= 500),
  handled_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists disputes_one_open_uniq on public.transaction_disputes (thread_id, reporter_id) where status in ('open', 'investigating');
create index if not exists disputes_status_idx on public.transaction_disputes (status, created_at desc);
alter table public.transaction_disputes enable row level security;
drop policy if exists disputes_read on public.transaction_disputes;
create policy disputes_read on public.transaction_disputes for select to authenticated using (reporter_id = auth.uid() or public.is_admin());

create or replace function public.report_dispute(p_thread uuid, p_reason text, p_detail text default '') returns bigint
language plpgsql security definer set search_path = public as $$
declare t public.threads; v_id bigint;
begin
  if auth.uid() is null or not public.is_active_user() then raise exception '請先登入並完成學校認證'; end if;
  select * into t from public.threads where id = p_thread and (buyer_id = auth.uid() or seller_id = auth.uid());
  if not found then raise exception '找不到這筆交易'; end if;
  if p_reason not in ('no_show', 'condition', 'price', 'harassment', 'other') then raise exception '請選擇爭議類型'; end if;
  if (select count(*) from public.transaction_disputes where reporter_id = auth.uid() and status in ('open', 'investigating')) >= 5 then raise exception '你同時處理中的爭議太多,請等管理員處理後再送出'; end if;
  insert into public.transaction_disputes (thread_id, reporter_id, reason, detail) values (p_thread, auth.uid(), p_reason, left(btrim(coalesce(p_detail, '')), 500)) returning transaction_disputes.id into v_id;
  return v_id;
exception when unique_violation then raise exception '這筆交易你已經送出爭議,管理員處理中';
end $$;
revoke all on function public.report_dispute(uuid, text, text) from public, anon;
grant execute on function public.report_dispute(uuid, text, text) to authenticated;

create or replace function public.admin_update_dispute(p_id bigint, p_status text, p_note text default '') returns void
language plpgsql security definer set search_path = public as $$
declare d public.transaction_disputes; lbl text;
begin
  if public.admin_role() not in ('super', 'moderator') then raise exception '沒有權限'; end if;
  if p_status not in ('investigating', 'resolved', 'dismissed') then raise exception '狀態不正確'; end if;
  select * into d from public.transaction_disputes where id = p_id;
  if not found then raise exception '找不到這筆爭議'; end if;
  update public.transaction_disputes set status = p_status, admin_note = left(btrim(coalesce(p_note, '')), 500), handled_by = auth.uid(), updated_at = now() where id = p_id;
  insert into public.moderation_log (admin_id, target_type, target_id, target_title, action, reason)
    values (auth.uid(), 'dispute', p_id::text, '交易爭議 #' || p_id, 'dispute_update', p_status || coalesce(':' || nullif(btrim(p_note), ''), ''));
  lbl := case p_status when 'investigating' then '管理員正在處理你的爭議' when 'resolved' then '你的交易爭議已處理完成' else '你的交易爭議已結案' end;
  perform public.notify_user(d.reporter_id, 'dispute', lbl, left(coalesce(nullif(btrim(p_note), ''), '請到「我的 → 交易紀錄」查看'), 150), '?tab=mine');
end $$;
revoke all on function public.admin_update_dispute(bigint, text, text) from public, anon;
grant execute on function public.admin_update_dispute(bigint, text, text) to authenticated;

-- ============ 4. 權限:新資料表訪客不能碰 ============
revoke all on public.notifications, public.notification_prefs, public.transaction_disputes from anon;
revoke truncate, trigger, references on public.semesters, public.courses, public.course_textbooks, public.notifications, public.notification_prefs, public.transaction_disputes from anon, authenticated;
