# palserver GUI — v2.9.0

遊戲出新版時,伺服器可以自己下載並安全重啟套用(**預設關閉**,要自己到「自動重啟」設定裡打開);配種計算改成一次給最多 5 條候選路線、背景執行緒邊算邊出結果,左側還有查詢歷史。另修好「明明已更新完,GUI 卻一直說有新版」。
When a new game build lands, the server can now download it and apply it through a safe restart on its own (**off by default** — turn it on in the auto-restart settings). Breeding planning now returns up to 5 candidate routes, streamed one by one from a background worker, with a query history alongside. Also fixes "already up to date, but the GUI keeps saying an update is available".
新しいゲームバージョンが出たとき、サーバーが自動でダウンロードして安全な再起動で適用できるようになりました(**既定はオフ** — 自動再起動の設定から有効化)。交配計算は候補ルートを最大 5 件、バックグラウンドワーカーから順次表示するようになり、検索履歴も追加。「更新済みなのに更新ありと表示され続ける」不具合も修正。

> 有開自動更新會自己抓,或依下方手動下載。
> The in-app updater fetches it automatically, or download below.
> 自動更新で取得、または下記から手動でダウンロード。

<details open>
<summary><b>🇹🇼 繁體中文</b></summary>

### 新功能
- **遊戲更新後自動安全重啟**(PR #73,teps3105;closes #72):偵測到新版就下載並走既有的安全序列(遊戲內公告 → 存檔 → 優雅關機 → 等舊程序真的退出 → 啟動),不必再靠手動或排程重啟順帶套用。native / Docker / k8s 三種後端都支援;Docker 與 k8s 用 **image digest** 比對(執行中的 image vs registry 最新),不依賴 Steam buildId 或版本字串。所有啟動與重啟入口(手動、排程、記憶體、崩潰復原)在啟動前都會先套用已下載的新版。版本卡會依開關分流提示。
  - **這個開關預設是關閉的**,既有伺服器升級後行為完全不變 —— 無人值守的重啟會把線上玩家全部踢掉,要不要用請自己決定。到「自動重啟」設定打開即可。
  - 更新失敗(連不到 Steam / registry)不會讓伺服器停在關著的狀態:記一筆失敗紀錄後,改用磁碟上現有的版本啟動,下次啟動再試。
  - k8s 會等伺服器自己走完公告倒數與存檔、容器退出之後才把 StatefulSet 縮到 0,並等 Pod 真的消失才啟動新的(避免新舊 Pod 搶同一個 PVC)。rollout 只 patch restart annotation,保留既有的 `imagePullPolicy`、image reference、`imagePullSecrets` 與其他容器。
- **配種計算:多路線規劃 + 背景計算**(PR #77,UCKETX;closes #69):一次設定一隻目標帕魯與被動詞條,最多列出 **5 條**不同的候選路線;改用 Web Worker 在背景算,算完一條顯示一條,計算期間頁面照常操作。左側新增查詢歷史可快速切回舊結果;可儲存常用的詞條組合;依物種結構與詞條來源去重,不會因為親代個體或性別不同而跑出重複路線。

### 修正
- **「已經是最新版,卻一直顯示有新版可更新」**(PR #75,abaa521):DepotDownloader 更新後不會刪掉舊的 `.manifest` 檔,而判斷「目前裝哪一版」是掃目錄後蓋前 —— `readdirSync` 的順序不保證是寫入順序(實務上接近字母序),舊 manifest id 字首較大時就會被當成目前版本,跟 Steam 一比對就永遠說有更新。改成取 **mtime 最新**的那一筆。
- **配種:切換查詢記錄會殘留上一次的錯誤訊息**;另清掉 25 個沒有被引用的介面字串。

</details>

<details>
<summary><b>🇨🇳 简体中文</b></summary>

### 新功能
- **游戏更新后自动安全重启**(PR #73,teps3105;closes #72):检测到新版就下载并走既有的安全序列(游戏内公告 → 存档 → 优雅关机 → 等旧进程真正退出 → 启动),不必再靠手动或计划重启顺带套用。native / Docker / k8s 三种后端都支持;Docker 与 k8s 用 **image digest** 比对(运行中的 image vs registry 最新),不依赖 Steam buildId 或版本字符串。所有启动与重启入口(手动、计划、内存、崩溃恢复)在启动前都会先套用已下载的新版。版本卡会依开关分流提示。
  - **这个开关默认是关闭的**,既有服务器升级后行为完全不变 —— 无人值守的重启会把在线玩家全部踢掉,要不要用请自行决定。到「自动重启」设置打开即可。
  - 更新失败(连不上 Steam / registry)不会让服务器停在关着的状态:记一笔失败记录后,改用磁盘上现有的版本启动,下次启动再试。
  - k8s 会等服务器自己走完公告倒计时与存档、容器退出之后才把 StatefulSet 缩到 0,并等 Pod 真正消失才启动新的(避免新旧 Pod 抢同一个 PVC)。rollout 只 patch restart annotation,保留既有的 `imagePullPolicy`、image reference、`imagePullSecrets` 与其他容器。
- **配种计算:多路线规划 + 后台计算**(PR #77,UCKETX;closes #69):一次设定一只目标帕鲁与被动词条,最多列出 **5 条**不同的候选路线;改用 Web Worker 在后台计算,算完一条展示一条,计算期间页面仍可正常交互。左侧新增查询历史可快速切回旧结果;可保存常用的词条组合;按物种结构与词条来源去重,不会因为亲代个体或性别不同产生重复路线。

### 修正
- **「已经是最新版,却一直显示有新版可更新」**(PR #75,abaa521):DepotDownloader 更新后不会删掉旧的 `.manifest` 文件,而判断「当前装哪一版」是扫目录后盖前 —— `readdirSync` 的顺序不保证是写入顺序(实际接近字母序),旧 manifest id 首字符较大时就会被当成当前版本,与 Steam 一比对就永远说有更新。改成取 **mtime 最新**的那一笔。
- **配种:切换查询记录会残留上一次的错误提示**;另清掉 25 个未被引用的界面字符串。

</details>

<details>
<summary><b>🇺🇸 English</b></summary>

### New
- **Automatic safe restart after a game update** (PR #73, teps3105; closes #72): when a new build is detected the server downloads it and applies it through the existing safe sequence (in-game announcement → save → graceful shutdown → wait for the old process to really exit → start), instead of relying on a manual or scheduled restart to pick it up. All three backends are covered; Docker and k8s compare **image digests** (running image vs. the registry's latest) rather than Steam build IDs or version strings. Every start/restart entry point (manual, scheduled, memory, crash recovery) applies a downloaded update before starting. The version card's prompt follows the toggle.
  - **The toggle is off by default**, so existing servers behave exactly as before — an unattended restart disconnects everyone who is online, so it is your call. Enable it under the auto-restart settings.
  - A failed update (Steam or registry unreachable) never leaves the server down: it is logged, the version already on disk starts, and the update is retried on the next start.
  - On k8s the StatefulSet is scaled to zero only after the server has finished its announced countdown and exited, and the replacement is started only once the old Pod is really gone (so the two never fight over the PVC). A rollout patches only the restart annotation, preserving the existing `imagePullPolicy`, image reference, `imagePullSecrets` and any other containers.
- **Breeding: multi-route planning with background computation** (PR #77, UCKETX; closes #69): pick one target pal and its passive skills and get up to **5** distinct candidate routes. The search now runs in a Web Worker, streaming each route as it is found, so the page stays responsive while it works. A query history on the left switches back to earlier results, favourite passive-skill sets can be saved, and routes are de-duplicated by species structure and skill origin so different parent individuals or genders no longer produce duplicates.

### Fixes
- **"Already up to date, but the GUI keeps offering an update"** (PR #75, abaa521): DepotDownloader leaves old `.manifest` files behind when it patches, and "which manifest is installed" was resolved by letting the last one seen while scanning the directory win. `readdirSync` order is not write order (in practice it is roughly alphabetical), so an older manifest id with a higher-sorting prefix was reported as the installed one — and the comparison against Steam then claimed an update forever. It now picks the file with the **newest mtime**.
- **Breeding**: switching between history entries no longer leaves the previous error banner on screen; 25 unreferenced UI strings removed.

</details>

<details>
<summary><b>🇯🇵 日本語</b></summary>

### 新機能
- **ゲーム更新後の自動セーフ再起動**(PR #73、teps3105、closes #72):新バージョンを検出するとダウンロードし、既存のセーフシーケンス(ゲーム内アナウンス → セーブ → グレースフルシャットダウン → 旧プロセスの終了待ち → 起動)で適用します。手動やスケジュール再起動のついでに適用させる必要はもうありません。native / Docker / k8s の 3 バックエンドに対応し、Docker と k8s は **image digest** 比較(実行中の image と registry の最新)を使うため、Steam の buildId やバージョン文字列に依存しません。すべての起動・再起動の入口(手動・スケジュール・メモリ・クラッシュ復帰)で、起動前にダウンロード済みの新版を適用します。
  - **既定はオフ**です。既存サーバーの挙動は一切変わりません —— 無人の再起動はオンラインのプレイヤー全員を切断するため、有効化するかはご判断ください。「自動再起動」の設定から有効にできます。
  - 更新の失敗(Steam / registry に接続できない等)でサーバーが停止したままになることはありません。記録を残したうえでディスク上の現行バージョンで起動し、次回起動時に再試行します。
  - k8s ではアナウンスのカウントダウンとセーブを終えてコンテナが終了してから StatefulSet を 0 にスケールし、旧 Pod が完全に消えてから新しい Pod を起動します(PVC の奪い合いを回避)。ロールアウトは restart annotation のみを patch し、既存の `imagePullPolicy`、image reference、`imagePullSecrets`、その他のコンテナを保持します。
- **交配計算:複数ルート提案とバックグラウンド計算**(PR #77、UCKETX、closes #69):目標のパルとパッシブスキルを 1 件設定すると、最大 **5 件**の異なる候補ルートを提示します。計算は Web Worker で実行され、1 件見つかるごとに順次表示。計算中もページは通常どおり操作できます。左側の検索履歴から過去の結果へすぐ戻れ、よく使うパッシブの組み合わせを保存でき、種の構造とスキルの由来で重複を排除するため、親個体や性別の違いで同じルートが重複表示されることもありません。

### 修正
- **「最新版なのに更新ありと表示され続ける」**(PR #75、abaa521):DepotDownloader は更新時に古い `.manifest` を削除しないため複数残りますが、「現在どれが入っているか」の判定は走査中に最後に見たものを採用していました。`readdirSync` の順序は書き込み順とは限らず(実際にはほぼアルファベット順)、古い manifest id の先頭文字が大きいとそれが現行として報告され、Steam との比較で永久に更新ありと判定されていました。**mtime が最新**のものを採用するよう修正。
- **交配**:検索履歴を切り替えたときに前回のエラー表示が残る問題を修正。未参照の UI 文字列 25 件を削除。

</details>
