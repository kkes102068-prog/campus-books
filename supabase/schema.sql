-- 校園二手書 v2:LINE 登入 + 站內聊聊 + 交易 + 後台
-- 在 Supabase Dashboard → SQL Editor 整份貼上執行一次。
--
-- 若你先前跑過舊版(v1)schema 且沒有正式資料,先執行下面這行重置(取消註解):
-- drop table if exists messages, threads, wishes, books, login_logs, admins, user_private, profiles cascade;

-- ============ 使用者 ============
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '同學' check (char_length(display_name) <= 100),
  picture_url  text not null default '',
  banned       boolean not null default false,
  created_at   timestamptz not null default now()
);

-- 私密資料(僅後台管理員可讀)
create table if not exists public.user_private (
  user_id       uuid primary key references public.profiles(id) on delete cascade,
  line_user_id  text not null unique,
  department    text not null default '' check (char_length(department) <= 60),
  last_login_at timestamptz,
  login_count   integer not null default 0
);

create table if not exists public.admins (
  user_id uuid primary key references public.profiles(id) on delete cascade
);

create table if not exists public.login_logs (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  ip         text not null default '',
  user_agent text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists login_logs_created_idx on public.login_logs (created_at desc);

-- ============ 權限輔助函式 ============
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid())
$$;

create or replace function public.is_active_user() returns boolean
language sql stable security definer set search_path = public as $$
  -- 未停權,且已填寫系所(首次登入必填)
  select exists (select 1 from public.profiles p join public.user_private u on u.user_id = p.id
                 where p.id = auth.uid() and not p.banned and u.department <> '')
$$;

-- ============ 書籍 ============
create table if not exists public.books (
  id             uuid primary key default gen_random_uuid(),
  seller_id      uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  title          text not null check (char_length(title) between 1 and 100),
  author         text not null default '' check (char_length(author) <= 60),
  course         text not null default '' check (char_length(course) <= 60),
  teacher        text not null default '' check (char_length(teacher) <= 60),
  course_dept    text not null default '' check (char_length(course_dept) <= 60),
  price          integer not null check (price between 0 and 99999),
  condition      text not null default '',
  image_url      text not null check (char_length(image_url) between 1 and 500),
  note           text not null default '' check (char_length(note) <= 200),
  allow_meetup   boolean not null default true,
  allow_shipping boolean not null default false,
  meetup_place   text not null default '' check (char_length(meetup_place) <= 60),
  shipping_fee   integer not null default 0 check (shipping_fee between 0 and 9999),
  status         text not null default 'active' check (status in ('active','reserved','sold','hidden')),
  created_at     timestamptz not null default now(),
  check (allow_meetup or allow_shipping),
  check (teacher <> '' or course_dept <> '')  -- 老師名稱或開課系所,至少填一項
);
create index if not exists books_status_created_idx on public.books (status, created_at desc);
create index if not exists books_seller_idx on public.books (seller_id);

-- ============ 願望 ============
create table if not exists public.wishes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  title      text not null check (char_length(title) between 1 and 100),
  course     text not null default '' check (char_length(course) <= 60),
  budget     integer check (budget between 0 and 99999),
  image_url  text not null default '' check (char_length(image_url) <= 500),
  note       text not null default '' check (char_length(note) <= 200),
  status     text not null default 'active' check (status in ('active','fulfilled','hidden')),
  created_at timestamptz not null default now()
);
create index if not exists wishes_status_created_idx on public.wishes (status, created_at desc);

-- ============ 交易(聊聊串)與訊息 ============
create table if not exists public.threads (
  id         uuid primary key default gen_random_uuid(),
  book_id    uuid references public.books(id) on delete set null,
  wish_id    uuid references public.wishes(id) on delete set null,
  buyer_id   uuid not null references public.profiles(id) on delete cascade,
  seller_id  uuid not null references public.profiles(id) on delete cascade,
  method     text check (method in ('meetup','shipping')),
  status     text not null default 'open' check (status in ('open','accepted','completed','cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (buyer_id <> seller_id)
);
create unique index if not exists threads_book_buyer_uniq on public.threads (book_id, buyer_id) where book_id is not null;
create unique index if not exists threads_wish_seller_uniq on public.threads (wish_id, seller_id) where wish_id is not null;
create index if not exists threads_buyer_idx on public.threads (buyer_id, updated_at desc);
create index if not exists threads_seller_idx on public.threads (seller_id, updated_at desc);

create table if not exists public.messages (
  id        bigint generated always as identity primary key,
  thread_id uuid not null references public.threads(id) on delete cascade,
  sender_id uuid references public.profiles(id) on delete set null,
  body      text not null check (char_length(body) between 1 and 1000),
  is_system boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists messages_thread_idx on public.messages (thread_id, id);

create or replace function public.is_thread_member(tid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.threads
                 where id = tid and (buyer_id = auth.uid() or seller_id = auth.uid()))
$$;

create or replace function public.can_post(tid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.threads
                 where id = tid and status <> 'cancelled'
                   and (buyer_id = auth.uid() or seller_id = auth.uid()))
$$;

-- 新訊息時更新交易的最後活動時間
create or replace function public.touch_thread() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.threads set updated_at = now() where id = new.thread_id;
  return new;
end $$;
drop trigger if exists messages_touch on public.messages;
create trigger messages_touch after insert on public.messages
  for each row execute function public.touch_thread();

-- ============ 交易流程函式(狀態轉換都在伺服器端驗證) ============
create or replace function public.start_thread(p_book_id uuid, p_method text) returns uuid
language plpgsql security definer set search_path = public as $$
declare b public.books; t public.threads; tid uuid; m text;
begin
  if auth.uid() is null or not public.is_active_user() then raise exception '請先登入'; end if;
  select * into b from public.books where id = p_book_id;
  if not found or b.status <> 'active' then raise exception '此書目前無法購買'; end if;
  if b.seller_id = auth.uid() then raise exception '不能購買自己的書'; end if;
  if p_method not in ('meetup','shipping')
     or (p_method = 'meetup' and not b.allow_meetup)
     or (p_method = 'shipping' and not b.allow_shipping) then
    raise exception '賣家不提供此交易方式';
  end if;
  m := case p_method when 'meetup' then '面交' else '寄送' end;

  select * into t from public.threads where book_id = p_book_id and buyer_id = auth.uid();
  if found then
    if t.status = 'cancelled' then
      update public.threads set status = 'open', method = p_method where id = t.id;
      insert into public.messages (thread_id, sender_id, body, is_system)
        values (t.id, auth.uid(), '買家重新提出購買,選擇「' || m || '」。', true);
    end if;
    return t.id;
  end if;

  insert into public.threads (book_id, buyer_id, seller_id, method)
    values (p_book_id, auth.uid(), b.seller_id, p_method) returning id into tid;
  insert into public.messages (thread_id, sender_id, body, is_system)
    values (tid, auth.uid(), '買家想購買《' || b.title || '》,選擇「' || m || '」交易。', true);
  return tid;
end $$;

create or replace function public.start_wish_thread(p_wish_id uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare w public.wishes; t public.threads; tid uuid;
begin
  if auth.uid() is null or not public.is_active_user() then raise exception '請先登入'; end if;
  select * into w from public.wishes where id = p_wish_id;
  if not found or w.status <> 'active' then raise exception '此願望已結束'; end if;
  if w.user_id = auth.uid() then raise exception '不能回應自己的願望'; end if;

  select * into t from public.threads where wish_id = p_wish_id and seller_id = auth.uid();
  if found then return t.id; end if;

  insert into public.threads (wish_id, buyer_id, seller_id)
    values (p_wish_id, w.user_id, auth.uid()) returning id into tid;
  insert into public.messages (thread_id, sender_id, body, is_system)
    values (tid, auth.uid(), '有同學說他有《' || w.title || '》,可以在這裡討論價格與交易方式。', true);
  return tid;
end $$;

create or replace function public.set_thread_status(p_thread uuid, p_status text) returns void
language plpgsql security definer set search_path = public as $$
declare t public.threads; uid uuid := auth.uid(); adm boolean := public.is_admin(); label text;
begin
  select * into t from public.threads where id = p_thread;
  if not found or not (t.seller_id = uid or t.buyer_id = uid or adm) then raise exception '找不到這筆交易'; end if;
  if t.status in ('completed','cancelled') then raise exception '交易已結束'; end if;

  if p_status = 'accepted' then
    if t.seller_id <> uid or t.status <> 'open' then raise exception '只有賣家可以確認交易'; end if;
    if t.book_id is not null then
      update public.books set status = 'reserved' where id = t.book_id and status in ('active','reserved');
      if not found then raise exception '這本書已售出或下架'; end if;
    end if;
    label := '賣家已確認交易,這本書狀態為「交易中」。';
  elsif p_status = 'completed' then
    if t.seller_id <> uid or t.status <> 'accepted' then raise exception '只有賣家可在確認後完成交易'; end if;
    if t.book_id is not null then update public.books set status = 'sold' where id = t.book_id; end if;
    if t.wish_id is not null then update public.wishes set status = 'fulfilled' where id = t.wish_id; end if;
    label := '交易已完成 🎉';
  elsif p_status = 'cancelled' then
    if t.book_id is not null and t.status = 'accepted' then
      update public.books set status = 'active' where id = t.book_id and status = 'reserved';
    end if;
    label := case when adm and uid not in (t.buyer_id, t.seller_id) then '管理員已取消這筆交易。' else '交易已取消。' end;
  else
    raise exception '不支援的狀態';
  end if;

  update public.threads set status = p_status, updated_at = now() where id = p_thread;
  insert into public.messages (thread_id, sender_id, body, is_system) values (p_thread, uid, label, true);
end $$;

-- 賣家設定自己書的狀態:未售出(active)/ 交易中(reserved)/ 已售出(sold)
create or replace function public.set_book_status(p_book uuid, p_status text) returns void
language plpgsql security definer set search_path = public as $$
declare b public.books; label text;
begin
  if p_status not in ('active','reserved','sold') then raise exception '不支援的狀態'; end if;
  select * into b from public.books where id = p_book;
  if not found or b.seller_id <> auth.uid() or not public.is_active_user() then raise exception '找不到這本書'; end if;
  if b.status = 'hidden' then raise exception '此書已下架'; end if;
  label := case p_status when 'active' then '未售出' when 'reserved' then '交易中' else '已售出' end;
  update public.books set status = p_status where id = p_book;
  insert into public.messages (thread_id, sender_id, body, is_system)
    select id, auth.uid(), '賣家將這本書的狀態改為「' || label || '」。', true
    from public.threads where book_id = p_book and status in ('open','accepted');
end $$;

revoke all on function public.set_book_status(uuid, text) from public, anon;
grant execute on function public.set_book_status(uuid, text) to authenticated;

-- 使用者填寫自己的系所(系所放在私密資料表,不會公開給其他使用者)
create or replace function public.set_my_department(p_department text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception '請先登入'; end if;
  if exists (select 1 from public.profiles where id = auth.uid() and banned) then raise exception '此帳號已被停權'; end if;
  p_department := btrim(p_department);
  if p_department is null or char_length(p_department) not between 1 and 60 then raise exception '請選擇系所'; end if;
  update public.user_private set department = p_department where user_id = auth.uid();
end $$;

revoke all on function public.set_my_department(text) from public, anon;
grant execute on function public.set_my_department(text) to authenticated;

revoke all on function public.start_thread(uuid, text), public.start_wish_thread(uuid), public.set_thread_status(uuid, text) from public, anon;
grant execute on function public.start_thread(uuid, text), public.start_wish_thread(uuid), public.set_thread_status(uuid, text) to authenticated;
grant execute on function public.is_admin() to anon, authenticated;

-- ============ Row Level Security ============
alter table public.profiles     enable row level security;
alter table public.user_private enable row level security;
alter table public.admins       enable row level security;
alter table public.login_logs   enable row level security;
alter table public.books        enable row level security;
alter table public.wishes       enable row level security;
alter table public.threads      enable row level security;
alter table public.messages     enable row level security;

-- profiles:暱稱/頭像公開(不含 LINE 帳號等私密資料),只有管理員能改(停權)
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to anon, authenticated using (true);
drop policy if exists profiles_admin_update on public.profiles;
create policy profiles_admin_update on public.profiles for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists user_private_admin on public.user_private;
create policy user_private_admin on public.user_private for select to authenticated using (user_id = auth.uid() or public.is_admin());
drop policy if exists admins_admin on public.admins;
create policy admins_admin on public.admins for select to authenticated using (public.is_admin());
drop policy if exists login_logs_admin on public.login_logs;
create policy login_logs_admin on public.login_logs for select to authenticated using (public.is_admin());

-- books
drop policy if exists books_read on public.books;
create policy books_read on public.books for select to anon, authenticated
  using (status in ('active','reserved','sold') or seller_id = auth.uid() or public.is_admin());
drop policy if exists books_insert on public.books;
create policy books_insert on public.books for insert to authenticated
  with check (seller_id = auth.uid() and status = 'active' and public.is_active_user());
drop policy if exists books_update_own on public.books;
create policy books_update_own on public.books for update to authenticated
  using (seller_id = auth.uid() and status in ('active','reserved','sold'))
  with check (seller_id = auth.uid() and status = 'hidden');
drop policy if exists books_admin_all on public.books;
create policy books_admin_all on public.books for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- wishes
drop policy if exists wishes_read on public.wishes;
create policy wishes_read on public.wishes for select to anon, authenticated
  using (status = 'active' or user_id = auth.uid() or public.is_admin());
drop policy if exists wishes_insert on public.wishes;
create policy wishes_insert on public.wishes for insert to authenticated
  with check (user_id = auth.uid() and status = 'active' and public.is_active_user());
drop policy if exists wishes_update_own on public.wishes;
create policy wishes_update_own on public.wishes for update to authenticated
  using (user_id = auth.uid() and status = 'active')
  with check (user_id = auth.uid() and status in ('fulfilled','hidden'));
drop policy if exists wishes_admin_all on public.wishes;
create policy wishes_admin_all on public.wishes for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- threads:只有買賣雙方與管理員可看;建立與狀態變更只能透過上面的函式
drop policy if exists threads_read on public.threads;
create policy threads_read on public.threads for select to authenticated
  using (buyer_id = auth.uid() or seller_id = auth.uid() or public.is_admin());

-- messages:只有買賣雙方與管理員可讀;只能以自己的身分發一般訊息
drop policy if exists messages_read on public.messages;
create policy messages_read on public.messages for select to authenticated
  using (public.is_thread_member(thread_id) or public.is_admin());
drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages for insert to authenticated
  with check (sender_id = auth.uid() and is_system = false
              and public.can_post(thread_id) and public.is_active_user());

-- 即時聊聊(Realtime)
do $$ begin
  alter publication supabase_realtime add table public.messages;
exception when duplicate_object then null; end $$;

-- ============ 圖片儲存桶(登入者才能上傳) ============
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('book-images', 'book-images', true, 2097152, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update
  set public = true, file_size_limit = 2097152, allowed_mime_types = array['image/jpeg','image/png','image/webp'];

drop policy if exists "public upload book images" on storage.objects;
drop policy if exists "auth upload book images" on storage.objects;
create policy "auth upload book images" on storage.objects
  for insert to authenticated with check (bucket_id = 'book-images');
drop policy if exists "public read book images" on storage.objects;
create policy "public read book images" on storage.objects
  for select to anon, authenticated using (bucket_id = 'book-images');

-- ============ 設定最高管理者(你第一次用 LINE 登入網站後再執行) ============
-- 1. 先用 LINE 登入一次網站。
-- 2. 到 Table Editor → profiles 找到自己的列(看暱稱),複製 id。
-- 3. 執行(把 id 換成你的):
-- insert into public.admins (user_id) values ('貼上你的 profiles.id');

-- ============ 舊資料庫升級(已執行過舊版 schema 才需要;新建的資料庫可忽略,重複執行也安全) ============
alter table public.user_private add column if not exists department text not null default '';
alter table public.books add column if not exists teacher text not null default '';
alter table public.books add column if not exists course_dept text not null default '';
alter table public.books drop constraint if exists books_teacher_or_dept;
alter table public.books add constraint books_teacher_or_dept check (teacher <> '' or course_dept <> '') not valid;

-- ============ 通知:未讀提示 / 瀏覽器推播 / Email ============
alter table public.user_private add column if not exists email text not null default '';
alter table public.user_private add column if not exists notify_email boolean not null default false;

-- 每人每串聊聊讀到哪一則(用來算未讀)
create table if not exists public.thread_reads (
  thread_id    uuid not null references public.threads(id) on delete cascade,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  last_read_id bigint not null default 0,
  primary key (thread_id, user_id)
);
alter table public.thread_reads enable row level security;  -- 不開放直接存取,只能透過下方函式

create or replace function public.mark_thread_read(p_thread uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or not public.is_thread_member(p_thread) then return; end if;
  insert into public.thread_reads (thread_id, user_id, last_read_id)
    select p_thread, auth.uid(), coalesce(max(id), 0) from public.messages where thread_id = p_thread
  on conflict (thread_id, user_id) do update set last_read_id = excluded.last_read_id;
end $$;

create or replace function public.unread_counts() returns table (thread_id uuid, unread bigint)
language sql stable security definer set search_path = public as $$
  select m.thread_id, count(*)::bigint
  from public.messages m
  join public.threads t on t.id = m.thread_id
  left join public.thread_reads r on r.thread_id = m.thread_id and r.user_id = auth.uid()
  where auth.uid() is not null
    and (t.buyer_id = auth.uid() or t.seller_id = auth.uid())
    and m.sender_id is distinct from auth.uid()
    and m.id > coalesce(r.last_read_id, 0)
  group by m.thread_id
$$;

-- 瀏覽器推播訂閱(只能透過函式存取)
create table if not exists public.push_subscriptions (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth_key   text not null,
  created_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);
alter table public.push_subscriptions enable row level security;

create or replace function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or not public.is_active_user() then raise exception '請先登入'; end if;
  if char_length(p_endpoint) > 1000 or char_length(p_p256dh) > 300 or char_length(p_auth) > 300 then raise exception '資料格式錯誤'; end if;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth_key)
    values (auth.uid(), p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update set user_id = auth.uid(), p256dh = excluded.p256dh, auth_key = excluded.auth_key;
end $$;

create or replace function public.remove_push_subscription(p_endpoint text) returns void
language sql security definer set search_path = public as $$
  delete from public.push_subscriptions where endpoint = p_endpoint and user_id = auth.uid()
$$;

-- Email 通知開關(Email 來自 LINE 登入,使用者無法自行填寫,避免被拿去寄給別人)
create or replace function public.set_notify_email(p_on boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception '請先登入'; end if;
  if p_on and coalesce((select email from public.user_private where user_id = auth.uid()), '') = '' then
    raise exception '你的 LINE 帳號沒有提供 email,無法開啟 Email 通知';
  end if;
  update public.user_private set notify_email = p_on where user_id = auth.uid();
end $$;

-- 通知節流紀錄(同一串聊聊同一人短時間內只通知一次;僅 Edge Function 使用)
create table if not exists public.notify_log (
  thread_id        uuid not null references public.threads(id) on delete cascade,
  user_id          uuid not null references public.profiles(id) on delete cascade,
  last_notified_at timestamptz not null default now(),
  primary key (thread_id, user_id)
);
alter table public.notify_log enable row level security;

revoke all on function public.mark_thread_read(uuid), public.unread_counts(),
  public.save_push_subscription(text, text, text), public.remove_push_subscription(text),
  public.set_notify_email(boolean) from public, anon;
grant execute on function public.mark_thread_read(uuid), public.unread_counts(),
  public.save_push_subscription(text, text, text), public.remove_push_subscription(text),
  public.set_notify_email(boolean) to authenticated;

-- ============ 同意書(使用條款)簽署 ============
-- 設定表:目前生效的同意書版本。修改 terms.js 後,到後台「同意書」頁更新版本,所有人下次進站會被要求重新簽署。
create table if not exists public.app_settings (
  key   text primary key,
  value text not null
);
alter table public.app_settings enable row level security;
insert into public.app_settings (key, value) values ('terms_version', '2026-10-23-v1') on conflict (key) do nothing;
drop policy if exists app_settings_read on public.app_settings;
create policy app_settings_read on public.app_settings for select to anon, authenticated using (key = 'terms_version');

create table if not exists public.consents (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  version     text not null,
  signed_name text not null check (char_length(signed_name) between 1 and 60),
  ip          text not null default '',
  user_agent  text not null default '',
  signed_at   timestamptz not null default now(),
  unique (user_id, version)
);
create index if not exists consents_signed_idx on public.consents (signed_at desc);
alter table public.consents enable row level security;
drop policy if exists consents_read on public.consents;
create policy consents_read on public.consents for select to authenticated using (user_id = auth.uid() or public.is_admin());

-- 簽署同意書:只需勾選同意(版本必須與目前生效版本相同;記錄 LINE 暱稱、時間、IP、裝置)
drop function if exists public.sign_consent(text, text);   -- 舊版(需輸入姓名)
create or replace function public.sign_consent(p_version text) returns void
language plpgsql security definer set search_path = public as $$
declare cur text; hdr json; nm text;
begin
  if auth.uid() is null then raise exception '請先登入'; end if;
  if exists (select 1 from public.profiles where id = auth.uid() and banned) then raise exception '此帳號已被停權'; end if;
  select value into cur from public.app_settings where key = 'terms_version';
  if p_version is distinct from cur then raise exception '同意書版本已更新,請重新整理頁面後再簽署'; end if;
  select left(coalesce(nullif(btrim(display_name), ''), '(LINE 使用者)'), 60) into nm from public.profiles where id = auth.uid();
  begin hdr := current_setting('request.headers', true)::json; exception when others then hdr := null; end;
  insert into public.consents (user_id, version, signed_name, ip, user_agent)
    values (auth.uid(), p_version, nm,
            btrim(split_part(coalesce(hdr->>'x-forwarded-for', ''), ',', 1)),
            left(coalesce(hdr->>'user-agent', ''), 300))
  on conflict (user_id, version) do nothing;
end $$;

create or replace function public.my_consent_ok() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.consents c
                 where c.user_id = auth.uid()
                   and c.version = (select value from public.app_settings where key = 'terms_version'))
$$;

-- 管理員更新同意書版本(所有人需重新簽署)
create or replace function public.set_terms_version(p_version text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception '沒有權限'; end if;
  p_version := btrim(p_version);
  if p_version is null or char_length(p_version) not between 1 and 60 then raise exception '版本格式錯誤'; end if;
  update public.app_settings set value = p_version where key = 'terms_version';
end $$;

revoke all on function public.sign_consent(text), public.my_consent_ok(), public.set_terms_version(text) from public, anon;
grant execute on function public.sign_consent(text), public.my_consent_ok(), public.set_terms_version(text) to authenticated;

-- 重新定義:必須「未停權 + 已填系所 + 已簽署目前版本的同意書」才能上架、許願、聊聊、購買
create or replace function public.is_active_user() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p join public.user_private u on u.user_id = p.id
                 where p.id = auth.uid() and not p.banned and u.department <> ''
                   and exists (select 1 from public.consents c
                               where c.user_id = p.id
                                 and c.version = (select value from public.app_settings where key = 'terms_version')))
$$;

-- ============ 管理員公告 / 廣播 ============
create table if not exists public.announcements (
  id         bigint generated always as identity primary key,
  title      text not null check (char_length(title) between 1 and 100),
  body       text not null check (char_length(body) between 1 and 2000),
  link       text not null default '' check (char_length(link) <= 500),
  channels   text[] not null default '{site}',          -- site / push / email / line
  result     jsonb not null default '{}'::jsonb,         -- 各管道送出結果
  active     boolean not null default true,
  expires_at timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists announcements_created_idx on public.announcements (created_at desc);
alter table public.announcements enable row level security;
drop policy if exists announcements_read on public.announcements;
create policy announcements_read on public.announcements for select to anon, authenticated
  using ((active and (expires_at is null or expires_at > now())) or public.is_admin());
drop policy if exists announcements_admin on public.announcements;
create policy announcements_admin on public.announcements for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ============ 匿名:使用者暱稱 / 頭像不再公開 ============
-- 只有「本人、管理員、與你有交易(聊聊)的對象」能讀到對方的暱稱與頭像;訪客與一般使用者讀不到。
create or replace function public.can_see_profile(pid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and (
    pid = auth.uid()
    or public.is_admin()
    or exists (select 1 from public.threads t
               where (t.buyer_id = auth.uid() and t.seller_id = pid)
                  or (t.seller_id = auth.uid() and t.buyer_id = pid))
  )
$$;
revoke all on function public.can_see_profile(uuid) from public, anon;
grant execute on function public.can_see_profile(uuid) to authenticated;

drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated using (public.can_see_profile(id));

-- ============ 管理員無條件下架 + 處置紀錄 ============
create table if not exists public.moderation_log (
  id           bigint generated always as identity primary key,
  admin_id     uuid references public.profiles(id) on delete set null,
  target_type  text not null,
  target_id    text not null,
  target_title text not null default '',
  action       text not null,                      -- hide / restore
  reason       text not null default '' check (char_length(reason) <= 500),
  created_at   timestamptz not null default now()
);
create index if not exists moderation_log_created_idx on public.moderation_log (created_at desc);
alter table public.moderation_log enable row level security;
drop policy if exists moderation_log_admin on public.moderation_log;
create policy moderation_log_admin on public.moderation_log for select to authenticated using (public.is_admin());

-- 管理員下架 / 恢復上架任何一本書(不論狀態、不論賣家):
-- 下架時會取消這本書進行中的交易,並在聊聊裡通知買家,同時寫入處置紀錄。
create or replace function public.admin_set_book_hidden(p_book uuid, p_hidden boolean, p_reason text default '') returns void
language plpgsql security definer set search_path = public as $$
declare b public.books; r text := left(coalesce(btrim(p_reason), ''), 500);
begin
  if not public.is_admin() then raise exception '沒有權限'; end if;
  select * into b from public.books where id = p_book;
  if not found then raise exception '找不到這本書'; end if;

  if p_hidden then
    update public.books set status = 'hidden' where id = p_book;
    insert into public.messages (thread_id, sender_id, body, is_system)
      select id, auth.uid(),
             '管理員已下架這本書' || case when r <> '' then '(原因:' || r || ')' else '' end || ',相關交易已取消。', true
      from public.threads where book_id = p_book and status in ('open', 'accepted');
    update public.threads set status = 'cancelled', updated_at = now()
      where book_id = p_book and status in ('open', 'accepted');
  else
    update public.books set status = 'active' where id = p_book;
  end if;

  insert into public.moderation_log (admin_id, target_type, target_id, target_title, action, reason)
    values (auth.uid(), 'book', p_book::text, b.title, case when p_hidden then 'hide' else 'restore' end, r);
end $$;

revoke all on function public.admin_set_book_hidden(uuid, boolean, text) from public, anon;
grant execute on function public.admin_set_book_hidden(uuid, boolean, text) to authenticated;
