-- 新訊息 → 呼叫 notify 函式(等同「Database Webhook」,用 SQL 建立)
-- 在 Supabase SQL Editor 貼上整段執行即可。可重複執行。
create extension if not exists pg_net with schema extensions;

create or replace function public.notify_new_message() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/notify',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer <SUPABASE_ANON_KEY>'),
    body    := jsonb_build_object('type', 'INSERT', 'table', 'messages', 'record', to_jsonb(new))
  );
  return new;
exception when others then
  return new;   -- 通知失敗絕不能影響訊息本身送出
end $$;

drop trigger if exists notify_new_message on public.messages;
create trigger notify_new_message after insert on public.messages
  for each row execute function public.notify_new_message();
