-- 聯絡管理員(客服聊聊)
-- 使用者在聊聊頁按「聯絡管理員」,就會開一條與管理員的對話(沿用現有聊聊與通知)。
-- 可重複執行;只新增欄位、索引與函式,不會刪除任何資料。請貼到 Supabase → SQL Editor 執行。

alter table public.threads add column if not exists kind text not null default 'trade';
do $$ begin
  alter table public.threads add constraint threads_kind_check check (kind in ('trade','support'));
exception when duplicate_object then null; end $$;

-- 每位使用者最多一條客服對話
create unique index if not exists threads_support_uniq on public.threads (buyer_id) where kind = 'support';

-- 對話的另一方是「第一位管理員」(admins 表依 user_id 排序取第一位)
create or replace function public.start_support_thread() returns uuid
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); adm uuid; t public.threads; tid uuid;
begin
  if uid is null or not public.is_active_user() then raise exception '請先登入'; end if;
  if public.is_admin() then raise exception '你就是管理員,不需要聯絡自己'; end if;
  select user_id into adm from public.admins order by user_id limit 1;
  if adm is null then raise exception '目前沒有設定管理員'; end if;

  select * into t from public.threads where buyer_id = uid and kind = 'support';
  if found then
    if t.status <> 'open' then
      update public.threads set status = 'open', seller_id = adm, updated_at = now() where id = t.id;
      insert into public.messages (thread_id, sender_id, body, is_system)
        values (t.id, uid, '使用者重新開啟了客服對話。', true);
    end if;
    return t.id;
  end if;

  insert into public.threads (buyer_id, seller_id, kind) values (uid, adm, 'support') returning id into tid;
  insert into public.messages (thread_id, sender_id, body, is_system)
    values (tid, uid, '你好!有任何問題都可以在這裡留言,管理員看到後會回覆你。', true);
  return tid;
end $$;
revoke all on function public.start_support_thread() from public, anon;
grant execute on function public.start_support_thread() to authenticated;
