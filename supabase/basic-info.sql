-- 註冊第一步:姓名、科系、入學年度(民國),方便管理員審核學生證時核對
-- 可重複執行;只新增欄位與函式,不會刪除資料。請在 student-card.sql 之後執行。

alter table public.user_private add column if not exists real_name text not null default '';
alter table public.user_private add column if not exists enroll_year smallint;

create or replace function public.save_basic_info(p_name text, p_dept text, p_year integer) returns void
language plpgsql security definer set search_path = public as $$
declare nm text := btrim(coalesce(p_name, '')); dp text := btrim(coalesce(p_dept, ''));
begin
  if auth.uid() is null then raise exception '請先登入'; end if;
  if exists (select 1 from public.profiles where id = auth.uid() and banned) then raise exception '此帳號已被停權'; end if;
  if char_length(nm) < 2 or char_length(nm) > 20 then raise exception '請輸入真實姓名(2 到 20 個字)'; end if;
  if dp = '' or char_length(dp) > 60 then raise exception '請選擇科系'; end if;
  if p_year is null or p_year < 90 or p_year > 160 then raise exception '請選擇入學年度(民國)'; end if;
  if exists (select 1 from public.user_private where user_id = auth.uid() and student_verified) then
    raise exception '你已經通過驗證,資料無法自行修改,如需更正請聯絡管理員';
  end if;
  update public.user_private set real_name = nm, department = dp, enroll_year = p_year where user_id = auth.uid();
  if not found then raise exception '找不到你的帳號資料'; end if;
end $$;
revoke all on function public.save_basic_info(text, text, integer) from public, anon;
grant execute on function public.save_basic_info(text, text, integer) to authenticated;
