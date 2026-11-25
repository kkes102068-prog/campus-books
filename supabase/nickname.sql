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
