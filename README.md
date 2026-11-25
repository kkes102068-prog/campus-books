# 北護校園二手書平台

一個讓校園同學買賣、許願二手教科書的網站:**LINE 登入、站內聊聊、匿名媒合**,全部使用免費方案架設(每月固定成本 0 元)。

> 這是一個學期專題。功能已寫好,但**部分項目尚未實機驗證**,見文末「目前狀態與限制」。

## 功能

- **LINE 登入**:只取得 LINE 暱稱,不加好友、不公開 LINE ID;頭像由使用者自選內建圖示,不儲存 LINE 頭貼
- **書籍上架與編輯**:一本書最多 5 張照片;上架後可編輯;點書卡看大圖、備註、交易方式
- **三種書籍狀態**:未售出 / 交易中 / 已售出,由賣家決定;不可買的書顯示為灰色
- **站內聊聊**:買家選面交或寄送後開啟聊天;可約定面交地點與時間;即時更新
- **許願池**:找不到的書先許願
- **聯絡管理員**:聊聊頁可直接找管理員
- **匿名**:公開的書列表與許願池不顯示任何人的資料;資料庫以 RLS 規則保護,不只是畫面隱藏
- **通知**:網站紅點、瀏覽器推播(Web Push,iPhone 需加入主畫面);通知不含聊天內容
- **LINE 官方帳號機器人**:私訊輸入書名搜書;群組內 @ 機器人才回應;只用「回覆」不耗推播額度
- **管理後台**:下架違規內容、發布公告、查看登入與處置紀錄、同意書簽署紀錄
- **使用同意書**:登入後須閱讀並勾選(含版本與時間紀錄)
- **登入碼**:給 iPhone 主畫面 App 接力登入用(6 位數、3 分鐘、限用一次)

## 技術與架構

| 零件 | 用途 |
|---|---|
| HTML / CSS / JavaScript(原生,Tailwind CDN) | 前端畫面,無打包工具 |
| Cloudflare(Workers 靜態資源) | 託管網站檔案 |
| Supabase | PostgreSQL 資料庫(含 RLS)、Storage(圖片)、Realtime(即時聊聊)、Edge Functions(後端小程式) |
| LINE Login / Messaging API | 第三方登入、官方帳號機器人 |
| Web Push(VAPID)+ Service Worker | 瀏覽器推播 |

```
你的手機 ──► Cloudflare(網站檔案)
   │
   └──► Supabase ──► 資料庫(RLS 門禁規則)
            ├──► Edge Functions:login(LINE 驗證)/ notify(通知)/ line-bot(機器人)
            └──► Realtime、Storage
```

核心設計原則:**前端不是安全邊界**。所有關鍵規則(誰能確認交易、同意書必須簽署、狀態轉換)都在資料庫函式與 RLS 規則裡驗證。

## 資料夾結構

```
├── index.html / app.js / styles.css   前台
├── admin.html / admin.js              管理後台
├── api.js                             資料層(未設定 Supabase 時為示範模式)
├── config.js                          設定檔(已換成佔位符)
├── terms.html / terms.js              使用同意書與法條摘要
├── sw.js / manifest.webmanifest       Service Worker 與 PWA
├── supabase/
│   ├── schema.sql                     資料表、RLS、交易流程函式
│   ├── login-code.sql 等 5 個 SQL     後續新增功能(合併版:全部新增SQL_依序執行.sql)
│   └── functions/                     line-login / notify / line-bot / broadcast
└── line/                              LINE 圖文選單圖片與建立腳本
```

## 自己架一份(概要)

1. 在 Supabase 建新專案,於 SQL Editor 先執行 `supabase/schema.sql`,再執行 `supabase/全部新增SQL_依序執行.sql`。
2. 部署 `supabase/functions/` 底下的 Edge Functions,並在 Secrets 設定 LINE Channel Secret、推播私鑰等(**不要**放進前端或 GitHub)。
3. 在 LINE Developers 建立 LINE Login 與 Messaging API 頻道,登錄網站網址為 Callback URL。
4. 把 `config.js` 的佔位符換成你自己的值(`<PROJECT_REF>`、`<SUPABASE_ANON_KEY>`、`<LINE_CHANNEL_ID>`、`<VAPID_PUBLIC_KEY>`)。
5. 上傳整個資料夾到靜態網站託管(例如 Cloudflare)。

> 本儲存庫**不含**任何私鑰、Channel Secret、資料庫密碼或 service_role 金鑰。`config.js` 內的金鑰類欄位皆為佔位符。anon key 與 VAPID 公鑰本來就設計為公開,但仍請換成你自己的。

## 目前狀態與限制

- 新功能(登入碼、客服聊聊、自選頭像與暱稱、上架編輯、多張照片)**只做過語法檢查,尚未做端對端實測**。
- iPhone 主畫面 App 是否一直保持登入、多款手機的推播是否送達:**未實機驗證**。Android 推播**未測**。
- 匿名是有程度的:聊聊內交易雙方看得到對方暱稱,管理員看得到全部。
- 免費方案的 Supabase 專案閒置約 7 天會被暫停,需到後台手動還原;流量與儲存空間有上限;未做大量使用者測試。
- 使用同意書的法律內容為一般性整理,不是法律意見,正式營運前需專業人員審閱。

## 關於 AI 協作

本專案由使用者與 AI(Claude Code)協作完成:使用者負責需求、取捨、各平台後台設定與實機測試;AI 負責撰寫程式、資料庫、後端函式與文件。AI 的輸出皆需人工驗證。

## 授權

尚未指定授權。如要公開使用或散布,請先自行選擇授權條款。

## 文件與架構圖

- [docs/ERD.md](docs/ERD.md):資料庫 ERD
- [docs/frontend-architecture.png](docs/frontend-architecture.png):前台功能架構圖
- 更多說明見 [docs/](docs/)

## 關於圖片(重要)

為避免版權問題,此公開儲存庫**不包含**以下圖片:吉祥物圖(`char-*.png`)、北護校徽/校名圖(`school-*.png`),以及含校徽的網站圖示(`logo.png`、`icon-*.png`、`apple-touch-icon.png`)。
網站程式仍會引用這些檔名;若要自行部署,請放入你有使用權的圖片(同檔名)即可。
