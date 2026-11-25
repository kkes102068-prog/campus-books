// 設定檔。anon key 與 VAPID 公鑰本來就設計為公開,安全性由 schema.sql 的 RLS 規則保護。
// 絕對不要把 service_role key、LINE Channel Secret、VAPID 私鑰、Brevo API key 放在這裡。
window.APP_CONFIG = {
  SUPABASE_URL: 'https://<PROJECT_REF>.supabase.co',         // Supabase → Project Settings → API → Project URL
  SUPABASE_ANON_KEY: '<SUPABASE_ANON_KEY>',    // 同一頁的 anon public key
  LINE_CHANNEL_ID: '<LINE_CHANNEL_ID>',      // LINE Developers → LINE Login channel → Channel ID(只有 ID,Secret 放在 Edge Function)
  LINE_REQUEST_EMAIL: false, // 已在 LINE 後台通過「email 權限」申請後才改 true(用於 Email 通知)
  VAPID_PUBLIC_KEY: '<VAPID_PUBLIC_KEY>',     // 瀏覽器推播用的公鑰(產生方式見 README)
  LINE_OA_URL: 'https://line.me/R/ti/p/@799yhgud',          // LINE 官方帳號加好友連結,例如 https://lin.ee/xxxxxx(選填,會顯示在網站頁尾)
  FN_LOGIN: 'smart-endpoint',  // 登入函式在 Supabase 的實際名稱(預設應為 line-login;你的專案被自動命名為 smart-endpoint)
  FN_VERIFY: '',               // 學校信箱驗證函式的名稱;留空 = verify-email
  ADMIN_PASSWORD_ONLY: true,   // 後台只能用「管理員帳號 + 密碼」登入(LINE 登入的帳號進不了後台);要暫時允許 LINE 管理員就改 false
  FN_BROADCAST: '',            // 廣播函式的實際名稱;留空 = broadcast
  LINE_BOT_PROMPT: true    // 已把官方帳號「連結」到 LINE Login channel 後可設 true:登入時順便詢問是否加官方帳號好友
};
