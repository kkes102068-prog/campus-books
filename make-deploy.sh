#!/bin/sh
# 產生只含「網站檔案」的部署資料夾 ../site-deploy(不含 README、schema、後端函式原始碼)
set -e
cd "$(dirname "$0")"
OUT=../site-deploy
rm -rf "$OUT" && mkdir -p "$OUT"
cp index.html admin.html terms.html styles.css app.js admin.js api.js config.js departments.js terms.js sw.js \
   manifest.webmanifest logo.png icon-192.png icon-512.png apple-touch-icon.png _headers "$OUT"/
echo "已產生 $OUT"
ls -1 "$OUT"
