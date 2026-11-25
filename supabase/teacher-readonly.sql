-- 給老師的「唯讀、去識別化」資料庫帳號 teacher_ro
-- 老師只能讀 teacher 這個結構(schema)裡的檢視表;看不到真實姓名、學號、LINE 代號、IP、聊天內容、學生證,
-- 使用者以「代號」(ref)取代;不能新增、修改、刪除任何資料。
-- 可重複執行。密碼不寫在這個檔案裡:請另外執行  alter role teacher_ro password '你自己設的密碼';

create schema if not exists teacher;

-- 代號:同一個使用者永遠是同一個代號,但無法反推身分
create or replace function teacher.ref(u uuid) returns text
language sql immutable as $$ select 'U' || substr(md5('campus-books-teacher:' || u::text), 1, 8) $$;

create or replace view teacher.users_summary as
  select teacher.ref(p.id) as user_ref, u.department, u.enroll_year, u.student_verified, u.verify_status,
         p.banned, u.login_count, p.created_at, u.last_login_at
  from public.profiles p join public.user_private u on u.user_id = p.id;

create or replace view teacher.books as
  select id, teacher.ref(seller_id) as seller_ref, title, author, course, course_dept, price, condition,
         allow_meetup, allow_shipping, meetup_place, shipping_fee, status, created_at
  from public.books;

create or replace view teacher.wishes as
  select id, teacher.ref(user_id) as user_ref, title, course, budget, status, created_at from public.wishes;

create or replace view teacher.threads as
  select id, kind, book_id, wish_id, teacher.ref(buyer_id) as buyer_ref, teacher.ref(seller_id) as seller_ref,
         method, status, created_at, updated_at
  from public.threads;

-- 訊息只給「誰、何時、多長」,不給內容
create or replace view teacher.messages as
  select id, thread_id, teacher.ref(sender_id) as sender_ref, is_system, char_length(body) as body_length, created_at
  from public.messages;

create or replace view teacher.ratings as
  select thread_id, teacher.ref(seller_id) as seller_ref, teacher.ref(rater_id) as rater_ref, stars, created_at
  from public.ratings;

create or replace view teacher.reports as
  select id, teacher.ref(reporter_id) as reporter_ref, teacher.ref(target_user_id) as target_ref, target_type, book_id,
         reason, status, created_at, handled_at
  from public.reports;

create or replace view teacher.moderation_log as
  select id, action, target_type, created_at from public.moderation_log;

create or replace view teacher.meetup_places as select id, name, sort, active from public.meetup_places;

-- 登入統計:只有日期與次數,沒有 IP 與裝置
create or replace view teacher.login_stats as
  select created_at::date as day, count(*) as logins, count(distinct user_id) as users
  from public.login_logs group by 1;

-- 每張資料表的筆數(方便老師概覽)
create or replace view teacher.table_counts as
  select 'profiles' as table_name, count(*) as rows from public.profiles
  union all select 'books', count(*) from public.books
  union all select 'wishes', count(*) from public.wishes
  union all select 'threads', count(*) from public.threads
  union all select 'messages', count(*) from public.messages
  union all select 'ratings', count(*) from public.ratings
  union all select 'reports', count(*) from public.reports
  union all select 'login_logs', count(*) from public.login_logs;

-- 帳號:只能讀、不能寫、查詢有時間上限、同時連線數有限
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'teacher_ro') then
    create role teacher_ro login;   -- 先不設密碼,沒有密碼就連不進來;密碼請在最後另外設定
  end if;
end $$;
alter role teacher_ro set default_transaction_read_only = on;
alter role teacher_ro set statement_timeout = '15s';
alter role teacher_ro connection limit 3;

revoke all on schema public from teacher_ro;
revoke all on all tables in schema public from teacher_ro;
grant usage on schema teacher to teacher_ro;
grant select on all tables in schema teacher to teacher_ro;
grant execute on function teacher.ref(uuid) to teacher_ro;

-- 網站的公開帳號(anon / authenticated)不需要碰這個結構
revoke all on schema teacher from anon, authenticated;
revoke all on all tables in schema teacher from anon, authenticated;
