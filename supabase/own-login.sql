-- 認證成功後,使用者可以設定「自己的 Email + 密碼」作為登入帳號(LINE 登入仍可用)
-- 在 Supabase SQL Editor 貼上執行即可(可重複執行)
alter table public.user_private add column if not exists own_login_set boolean not null default false;

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
  update public.user_private set own_login_set = true where user_id = uid;
end $$;
revoke all on function public.set_my_credentials(text, text) from public, anon;
grant execute on function public.set_my_credentials(text, text) to authenticated;
