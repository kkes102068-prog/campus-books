-- 改用「上傳學生證」驗證在校生(取代 Email 驗證碼)
-- 可重複執行;只新增欄位、函式與私人儲存桶,不會刪除使用者資料。
-- 執行順序:school-rules.sql 之後,再貼這一份到 Supabase → SQL Editor。

-- ============ 1. 欄位:學號、審核狀態 ============
alter table public.user_private add column if not exists student_no text not null default '';
alter table public.user_private add column if not exists verify_status text not null default 'none';
alter table public.user_private add column if not exists verify_card_path text not null default '';
alter table public.user_private add column if not exists verify_note text not null default '';
alter table public.user_private add column if not exists verify_submitted_at timestamptz;

do $$ begin
  alter table public.user_private add constraint user_private_verify_status_chk
    check (verify_status in ('none', 'pending', 'approved', 'rejected'));
exception when duplicate_object then null; end $$;

-- 已經通過驗證的人,狀態標為 approved
update public.user_private set verify_status = 'approved' where student_verified and verify_status = 'none';

-- 一個學號只能註冊一次(資料庫層級強制)
create unique index if not exists user_private_student_no_uniq on public.user_private (student_no) where student_no <> '';

-- ============ 2. 學生證照片:私人儲存桶 ============
-- 只有本人能上傳到「自己 ID 的資料夾」;只有管理員能看與刪除;任何人都不是公開網址
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('student-cards', 'student-cards', false, 3145728, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update
  set public = false, file_size_limit = 3145728, allowed_mime_types = array['image/jpeg','image/png','image/webp'];

drop policy if exists "student card upload own" on storage.objects;
create policy "student card upload own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'student-cards' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "student card admin read" on storage.objects;
create policy "student card admin read" on storage.objects
  for select to authenticated using (bucket_id = 'student-cards' and public.is_admin());
drop policy if exists "student card admin delete" on storage.objects;
create policy "student card admin delete" on storage.objects
  for delete to authenticated using (bucket_id = 'student-cards' and public.is_admin());

-- ============ 3. 同學送出:學號 + 學生證照片 ============
create or replace function public.submit_student_card(p_no text, p_path text) returns void
language plpgsql security definer set search_path = public as $$
declare no text := upper(btrim(coalesce(p_no, ''))); up public.user_private;
begin
  if auth.uid() is null then raise exception '請先登入'; end if;
  if exists (select 1 from public.profiles where id = auth.uid() and banned) then raise exception '此帳號已被停權'; end if;
  if no !~ '^[0-9A-Z]{6,12}$' then raise exception '學號格式不正確(6 到 12 個英數字)'; end if;
  if p_path is null or left(p_path, 37) <> auth.uid()::text || '/' then raise exception '學生證照片不正確,請重新上傳'; end if;
  select * into up from public.user_private where user_id = auth.uid();
  if not found then raise exception '找不到你的帳號資料'; end if;
  if up.student_verified then raise exception '你已經通過驗證了'; end if;
  if up.verify_submitted_at is not null and up.verify_submitted_at > now() - interval '20 seconds' then
    raise exception '送出太頻繁,請稍後再試';
  end if;
  if exists (select 1 from public.user_private where student_no = no and user_id <> auth.uid()) then
    raise exception '這個學號已經被註冊過了(一個學號只能註冊一次)。如果是你的學號被別人使用,請聯絡管理員';
  end if;
  begin
    update public.user_private
       set student_no = no, verify_status = 'pending', verify_card_path = p_path, verify_note = '', verify_submitted_at = now()
     where user_id = auth.uid();
  exception when unique_violation then
    raise exception '這個學號已經被註冊過了(一個學號只能註冊一次)。如果是你的學號被別人使用,請聯絡管理員';
  end;
end $$;
revoke all on function public.submit_student_card(text, text) from public, anon;
grant execute on function public.submit_student_card(text, text) to authenticated;

-- ============ 4. 管理員審核:通過 / 退回(回傳照片路徑,讓後台刪掉照片) ============
create or replace function public.admin_review_student(p_user uuid, p_ok boolean, p_note text default '') returns text
language plpgsql security definer set search_path = public as $$
declare up public.user_private; n text := left(coalesce(btrim(p_note), ''), 200); nm text; old_path text;
begin
  if not public.is_admin() then raise exception '沒有權限'; end if;
  select * into up from public.user_private where user_id = p_user;
  if not found then raise exception '找不到這位使用者'; end if;
  if up.verify_status <> 'pending' then raise exception '這筆申請已經處理過了'; end if;
  old_path := up.verify_card_path;
  select display_name into nm from public.profiles where id = p_user;
  if p_ok then
    update public.user_private
       set student_verified = true, verified_at = now(), verify_status = 'approved', verify_card_path = '', verify_note = ''
     where user_id = p_user;
  else
    -- 退回:清掉學號,讓真正的本人之後可以用這個學號註冊
    update public.user_private
       set student_verified = false, verified_at = null, verify_status = 'rejected', verify_card_path = '', student_no = '', verify_note = n
     where user_id = p_user;
  end if;
  insert into public.moderation_log (admin_id, target_type, target_id, target_title, action, reason)
    values (auth.uid(), 'user', p_user::text, coalesce(nm, ''), case when p_ok then 'verify' else 'reject_verify' end, case when p_ok then '學生證審核通過' else n end);
  return old_path;
end $$;
revoke all on function public.admin_review_student(uuid, boolean, text) from public, anon;
grant execute on function public.admin_review_student(uuid, boolean, text) to authenticated;

-- 管理員手動核准 / 取消(沒有學生證的特殊情況):同步狀態
create or replace function public.admin_set_verified(p_user uuid, p_ok boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception '沒有權限'; end if;
  update public.user_private
     set student_verified = p_ok, verified_at = case when p_ok then now() else null end,
         verify_status = case when p_ok then 'approved' else 'none' end,
         student_no = case when p_ok then student_no else '' end
   where user_id = p_user;
  insert into public.moderation_log (admin_id, target_type, target_id, target_title, action, reason)
    select auth.uid(), 'user', p_user::text, coalesce((select display_name from public.profiles where id = p_user), ''),
           case when p_ok then 'verify' else 'unverify' end, '管理員手動操作';
end $$;
revoke all on function public.admin_set_verified(uuid, boolean) from public, anon;
grant execute on function public.admin_set_verified(uuid, boolean) to authenticated;
