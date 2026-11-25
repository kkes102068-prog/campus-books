// 建立並啟用 LINE 官方帳號的圖文選單(找書 / 賣書 / 許願 / 聊聊)。需要 Node 18+。
//
// 用法(在 campus-books 資料夾內執行):
//   Windows PowerShell:
//     $env:LINE_BOT_TOKEN="你的 Channel access token"; $env:SITE_URL="https://你的網站"; node line/setup-richmenu.mjs
//   macOS / Linux:
//     LINE_BOT_TOKEN=... SITE_URL=https://你的網站 node line/setup-richmenu.mjs
//
// 圖片預設使用 line/richmenu.png(2500x843);要換成自己的設計,覆蓋同檔名即可(需 PNG/JPEG、小於 1MB)。
import { readFile } from 'node:fs/promises';

const TOKEN = process.env.LINE_BOT_TOKEN;
const SITE = (process.env.SITE_URL || '').replace(/\/$/, '');
if (!TOKEN || !SITE) { console.error('請設定環境變數 LINE_BOT_TOKEN 與 SITE_URL'); process.exit(1); }

const api = (path, init = {}, base = 'https://api.line.me') =>
  fetch(base + path, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, ...(init.headers || {}) } });

const pw = 625; // 2500 / 4
const menu = {
  size: { width: 2500, height: 843 },
  selected: true,
  name: 'campus-books-menu',
  chatBarText: '選單',
  areas: [
    { bounds: { x: 0, y: 0, width: pw, height: 843 }, action: { type: 'uri', label: '找書', uri: `${SITE}/` } },
    { bounds: { x: pw, y: 0, width: pw, height: 843 }, action: { type: 'uri', label: '賣書', uri: `${SITE}/?sell=1` } },
    { bounds: { x: pw * 2, y: 0, width: pw, height: 843 }, action: { type: 'uri', label: '許願', uri: `${SITE}/?wish=1` } },
    { bounds: { x: pw * 3, y: 0, width: pw, height: 843 }, action: { type: 'uri', label: '聊聊', uri: `${SITE}/?tab=chat` } },
  ],
};

const created = await api('/v2/bot/richmenu', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(menu) });
if (!created.ok) { console.error('建立失敗', created.status, await created.text()); process.exit(1); }
const { richMenuId } = await created.json();
console.log('已建立 richMenuId:', richMenuId);

const image = await readFile(new URL('./richmenu.png', import.meta.url));
const up = await api(`/v2/bot/richmenu/${richMenuId}/content`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: image }, 'https://api-data.line.me');
if (!up.ok) { console.error('上傳圖片失敗', up.status, await up.text()); process.exit(1); }
console.log('已上傳圖片');

const def = await api(`/v2/bot/user/all/richmenu/${richMenuId}`, { method: 'POST' });
if (!def.ok) { console.error('設為預設失敗', def.status, await def.text()); process.exit(1); }
console.log('✅ 已設為所有使用者的預設選單。');
