-- 管理員工具:取消認證(含原因)、查看使用者登入 Email、重設密碼、測試同學帳號
-- 在 Supabase SQL Editor 貼上執行(可重複執行)。需先執行 own-login.sql。
alter table public.user_private add column if not exists own_login_at timestamptz;

-- 設定登入帳號時,記錄最後修改時間(覆蓋 own-login.sql 的版本)
create or replace function public.set_my_credentials(p_email text, p_password text)
returns void language plpgsql security definer set search_path = public, auth, extensions as $$
declare
  uid uuid := auth.uid();
  em text := lower(btrim(coalesce(p_email, '')));
begin
  if uid is null then raise exception '請先登入'; end if;
  if not exists (select 1 from public.user_private where user_id = uid and student_verified) then
    raise exception '完成學生證認證後才能設定登入帳號';
  end if;
  if em !~ '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$' or length(em) > 120 then raise exception 'Email 格式不正確'; end if;
  if em like '%@line-login.example.com' then raise exception '請輸入你自己的 Email'; end if;
  if length(coalesce(p_password, '')) < 8 or length(p_password) > 72 then raise exception '密碼要 8 到 72 個字元'; end if;
  if p_password !~ '[A-Za-z]' or p_password !~ '[0-9]' then raise exception '密碼要同時包含英文字母和數字'; end if;
  if exists (select 1 from auth.users where lower(email) = em and id <> uid) then
    raise exception '這個 Email 已經被使用了';
  end if;
  update auth.users
     set email = em, email_confirmed_at = coalesce(email_confirmed_at, now()),
         encrypted_password = crypt(p_password, gen_salt('bf', 10)), updated_at = now()
   where id = uid;
  update auth.identities
     set identity_data = jsonb_set(coalesce(identity_data, '{}'::jsonb), '{email}', to_jsonb(em)),
         provider_id = em, updated_at = now()
   where user_id = uid and provider = 'email';
  update public.user_private set own_login_set = true, own_login_at = now() where user_id = uid;
end $$;
revoke all on function public.set_my_credentials(text, text) from public, anon;
grant execute on function public.set_my_credentials(text, text) to authenticated;

-- 取消認證(要填原因,會顯示給同學看;清掉學號讓本人可重新申請)
create or replace function public.admin_revoke_verify(p_user uuid, p_note text default '') returns void
language plpgsql security definer set search_path = public as $$
declare n text := left(coalesce(btrim(p_note), ''), 200);
begin
  if not public.is_admin() then raise exception '沒有權限'; end if;
  if not exists (select 1 from public.user_private where user_id = p_user) then raise exception '找不到這位使用者'; end if;
  update public.user_private
     set student_verified = false, verified_at = null, verify_status = 'rejected', verify_card_path = '', student_no = '', verify_note = n
   where user_id = p_user;
  insert into public.moderation_log (admin_id, target_type, target_id, target_title, action, reason)
    values (auth.uid(), 'user', p_user::text, coalesce((select display_name from public.profiles where id = p_user), ''), 'unverify', coalesce(nullif(n, ''), '管理員取消認證'));
end $$;
revoke all on function public.admin_revoke_verify(uuid, text) from public, anon;
grant execute on function public.admin_revoke_verify(uuid, text) to authenticated;

-- 管理員查看:哪些使用者設定了登入 Email(看不到密碼,密碼只以雜湊存放)
create or replace function public.admin_user_logins()
returns table(user_id uuid, login_email text, changed_at timestamptz)
language plpgsql security definer set search_path = public, auth as $$
begin
  if not public.is_admin() then raise exception '沒有權限'; end if;
  return query
    select up.user_id, u.email::text, up.own_login_at
      from public.user_private up join auth.users u on u.id = up.user_id
     where up.own_login_set;
end $$;
revoke all on function public.admin_user_logins() from public, anon;
grant execute on function public.admin_user_logins() to authenticated;

-- 管理員重設某位同學的密碼:產生一組臨時密碼(只顯示一次),並寫入操作紀錄
create or replace function public.admin_reset_password(p_user uuid) returns text
language plpgsql security definer set search_path = public, auth, extensions as $$
declare pw text := 'Tmp' || substr(encode(gen_random_bytes(8), 'hex'), 1, 8) || '7';
begin
  if not public.is_admin() then raise exception '沒有權限'; end if;
  if not exists (select 1 from public.user_private where user_id = p_user and own_login_set) then
    raise exception '這位同學還沒有設定登入帳號';
  end if;
  update auth.users set encrypted_password = crypt(pw, gen_salt('bf', 10)), updated_at = now() where id = p_user;
  update public.user_private set own_login_at = now() where user_id = p_user;
  insert into public.moderation_log (admin_id, target_type, target_id, target_title, action, reason)
    values (auth.uid(), 'user', p_user::text, coalesce((select display_name from public.profiles where id = p_user), ''), 'reset_password', '管理員重設密碼');
  return pw;
end $$;
revoke all on function public.admin_reset_password(uuid) from public, anon;
grant execute on function public.admin_reset_password(uuid) to authenticated;

-- 測試同學帳號:管理員一鍵取得登入資料(已認證、已同意書、已設定登入帳號的一般同學)
create or replace function public.admin_prepare_test_account() returns table(email text, password text)
language plpgsql security definer set search_path = public, auth, extensions as $$
declare
  em constant text := 'test.student@example.com';
  uid uuid;
  pw text := 'Test' || substr(encode(gen_random_bytes(8), 'hex'), 1, 8) || '9';
  ver text;
begin
  if not public.is_admin() then raise exception '沒有權限'; end if;
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
