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
