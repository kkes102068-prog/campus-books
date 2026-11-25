-- 上架後可編輯 + 一本書最多 5 張照片
-- 可重複執行;只新增欄位與函式,不會刪除任何資料。請貼到 Supabase → SQL Editor 執行。

-- 封面照仍放在 image_url;其餘照片(最多 4 張)放在 extra_images
alter table public.books add column if not exists extra_images text[] not null default '{}';
do $$ begin
  alter table public.books add constraint books_extra_images_check check (cardinality(extra_images) <= 4);
exception when duplicate_object then null; end $$;

-- 賣家編輯自己的書(狀態仍只能用 set_book_status 改;已下架或已售出不能編輯)
create or replace function public.update_my_book(
  p_book uuid, p_title text, p_author text, p_course text, p_teacher text, p_course_dept text,
  p_price integer, p_note text, p_allow_meetup boolean, p_allow_shipping boolean,
  p_meetup_place text, p_shipping_fee integer, p_image_url text, p_extra_images text[]
) returns void
language plpgsql security definer set search_path = public as $$
declare b public.books; u text;
begin
  if auth.uid() is null or not public.is_active_user() then raise exception '請先登入'; end if;
  select * into b from public.books where id = p_book;
  if not found or b.seller_id <> auth.uid() then raise exception '找不到這本書'; end if;
  if b.status not in ('active','reserved') then raise exception '這本書目前不能編輯'; end if;
  p_extra_images := coalesce(p_extra_images, '{}');
  if p_image_url is null or p_image_url !~ '^https://' then raise exception '請至少保留一張照片'; end if;
  foreach u in array p_extra_images loop
    if u !~ '^https://' or char_length(u) > 500 then raise exception '照片網址不正確'; end if;
  end loop;
  update public.books set
    title = btrim(p_title), author = btrim(coalesce(p_author, '')), course = btrim(coalesce(p_course, '')),
    teacher = btrim(coalesce(p_teacher, '')), course_dept = coalesce(p_course_dept, ''),
    price = p_price, note = btrim(coalesce(p_note, '')),
    allow_meetup = p_allow_meetup, allow_shipping = p_allow_shipping,
    meetup_place = btrim(coalesce(p_meetup_place, '')), shipping_fee = coalesce(p_shipping_fee, 0),
    image_url = p_image_url, extra_images = p_extra_images
  where id = p_book;
end $$;
revoke all on function public.update_my_book(uuid, text, text, text, text, text, integer, text, boolean, boolean, text, integer, text, text[]) from public, anon;
grant execute on function public.update_my_book(uuid, text, text, text, text, text, integer, text, boolean, boolean, text, integer, text, text[]) to authenticated;
