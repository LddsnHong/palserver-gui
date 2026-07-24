# palserver GUI — v2.8.1

通知系統大升級的一版:事件通知新增 **飞书、Slack、企業微信、钉钉、Google Chat、Telegram** 六大平台;官方 Discord 機器人修好「只設 bot 收不到聊天/頭目」並支援多頻道;啟動時自動偵測四人存檔的設定衝突。另含效能分頁重設計、Docker ARM64 / Wine 強化與多項修復。
A notifications-focused release: event notifications now support six more platforms — **Feishu, Slack, WeCom, DingTalk, Google Chat, Telegram**; the official Discord bot now delivers chat/boss events even without a webhook and supports multiple channels; startup auto-detects the co-op save's config conflict. Also a redesigned Performance tab, Docker ARM64/Wine improvements, and many fixes.
通知機能を大幅強化したリリース:イベント通知が **Feishu・Slack・WeCom・DingTalk・Google Chat・Telegram** に対応。公式 Discord ボットは webhook なしでもチャット/ボス通知を配信し、複数チャンネルに対応。起動時に4人セーブの設定競合を自動検出。パフォーマンスタブの再設計、Docker ARM64/Wine 強化、多数の修正も。

> 有開自動更新會自己抓,或依下方手動下載。
> The in-app updater fetches it automatically, or download below.
> 自動更新で取得、または下記から手動でダウンロード。

<details>
<summary><b>🇹🇼 繁體中文</b></summary>

### 重點更新
- **事件通知支援 6 大新平台**:Webhook 通知從 Discord / 自訂端點擴充到 **飞书(Lark)、Slack、企業微信、钉钉、Google Chat、Telegram**(Slack 格式亦相容 Mattermost / Rocket.Chat)。同時修好回報的「飞书 ping 成功、卻收不到訊息」—— 那是格式不符加上「HTTP 200 就當成功」的誤判,現在會解析平台回應的錯誤碼,真失敗就顯示真失敗。
- **Discord 官方機器人修復 + 多頻道**:修好「只設定 bot、沒設對應 Webhook 時收不到聊天/頭目通知」;事件通知改為**多條路由**,可把不同事件送到不同頻道(例如聊天獨立一個頻道),或同時送到多個 Discord 群組。
- **啟動時偵測四人存檔設定衝突**:從連線(四人)存檔搬上專用伺服器時常遺留 `WorldOptions.sav`,它會蓋掉 `PalWorldSettings.ini`(連管理員密碼一起),造成「改了設定不生效、玩家列表顯示管理員密碼不符」。現在啟動伺服器時會偵測到並跳出說明視窗,一鍵移除該檔(自動備份、可還原)後繼續啟動。
- **效能分頁重設計**:CPU 改為 per-core / per-thread 採集與正規化(佔總算力),新增影格時間走勢,三欄容器重新排版對齊。

### 新功能與改進
- **公會據點刪除**:公會詳情可經 PalDefender 即時刪除據點(贊助者先行,附強確認)。
- **線上地圖據點下鑽**:點地圖上的據點可逐層看「簡單 → 完整 → 公會」資訊。
- **Docker 強化**:新增 ARM64 image、native 也支援 Wine 強化、image 自動 build/pull 與部署指引。
- **RCON / 日誌修復**:修好 RCON 中文命令與 Windows 日誌亂碼(保留 Unicode);Base64 RCON 設定在地化。
- **玩家清單修復**:修離線玩家重複顯示、支援跨平台(Steam / Xbox…)使用者 ID。
- 模組下載避免觸發 GitHub API 限流;UE4SS 開發版(zDev)不再誤報「有新版」。

</details>

<details>
<summary><b>🇨🇳 简体中文</b></summary>

### 重点更新
- **事件通知支持 6 大新平台**:Webhook 通知从 Discord / 自定义端点扩充到 **飞书(Lark)、Slack、企业微信、钉钉、Google Chat、Telegram**(Slack 格式也兼容 Mattermost / Rocket.Chat)。同时修好反馈的「飞书 ping 成功、却收不到消息」—— 那是格式不符加上「HTTP 200 就当成功」的误判,现在会解析平台响应的错误码,真失败就显示真失败。
- **Discord 官方机器人修复 + 多频道**:修好「只设置 bot、没设对应 Webhook 时收不到聊天/头目通知」;事件通知改为**多条路由**,可把不同事件送到不同频道(例如聊天单独一个频道),或同时送到多个 Discord 群组。
- **启动时检测四人存档设置冲突**:从联机(四人)存档搬到专用服务器时常遗留 `WorldOptions.sav`,它会覆盖 `PalWorldSettings.ini`(连管理员密码一起),导致「改了设置不生效、玩家列表显示管理员密码不符」。现在启动服务器时会检测到并弹出说明窗口,一键移除该文件(自动备份、可还原)后继续启动。
- **性能分页重设计**:CPU 改为 per-core / per-thread 采集与归一化(占总算力),新增帧时间走势,三栏容器重新排版对齐。

### 新功能与改进
- **公会据点删除**:公会详情可经 PalDefender 即时删除据点(赞助者先行,附强确认)。
- **在线地图据点下钻**:点地图上的据点可逐层查看「简单 → 完整 → 公会」信息。
- **Docker 强化**:新增 ARM64 镜像、native 也支持 Wine 强化、镜像自动 build/pull 与部署指引。
- **RCON / 日志修复**:修好 RCON 中文命令与 Windows 日志乱码(保留 Unicode);Base64 RCON 设置本地化。
- **玩家列表修复**:修离线玩家重复显示、支持跨平台(Steam / Xbox…)用户 ID。
- 模组下载避免触发 GitHub API 限流;UE4SS 开发版(zDev)不再误报「有新版」。

</details>

<details>
<summary><b>🇺🇸 English</b></summary>

### Highlights
- **Event notifications for 6 more platforms**: webhook notifications now cover **Feishu (Lark), Slack, WeCom, DingTalk, Google Chat, and Telegram** in addition to Discord / custom endpoints (the Slack format also works with Mattermost / Rocket.Chat). Also fixes the reported "Feishu ping succeeds but nothing arrives" — that was a format mismatch plus treating "HTTP 200" as success; delivery now parses the platform's response code, so a real failure shows as a failure.
- **Official Discord bot fix + multiple channels**: fixed "chat/boss notifications not received when only the bot is configured (no matching webhook)". Event notifications now use **multiple routes** — send different events to different channels (e.g. chat to its own channel), or the same events to several Discord servers at once.
- **Detects the co-op save config conflict at startup**: moving a co-op world onto a dedicated server often leaves a `WorldOptions.sav`, which overrides `PalWorldSettings.ini` (including the admin password) — causing "settings don't apply, admin password shows as mismatched". Startup now detects it and shows an explanation dialog; one click removes the file (backed up, reversible) and continues starting.
- **Redesigned Performance tab**: CPU is now collected per-core / per-thread and normalized (share of total capacity), with a frame-time trend and a re-aligned three-panel layout.

### New features & improvements
- **Delete guild bases**: remove a base from the guild detail view via PalDefender in real time (sponsor early-access, with a strong confirm).
- **Map base drill-down**: click a base on the map to view "simple → full → guild" info in layers.
- **Docker improvements**: new ARM64 image, Wine enhancement on native too, automatic image build/pull, and deployment guidance.
- **RCON / log fixes**: fixed RCON Chinese commands and garbled Windows logs (Unicode preserved); localized the Base64 RCON setting.
- **Player list fixes**: fixed duplicate offline players; support cross-platform (Steam / Xbox…) user IDs.
- Mod downloads avoid hitting GitHub API rate limits; UE4SS dev build (zDev) no longer falsely reports "update available".

</details>

<details>
<summary><b>🇯🇵 日本語</b></summary>

### 主なアップデート
- **イベント通知が6プラットフォームに対応**:Webhook 通知が Discord / カスタムエンドポイントに加えて **Feishu(Lark)、Slack、WeCom(企業微信)、DingTalk(钉钉)、Google Chat、Telegram** に対応(Slack 形式は Mattermost / Rocket.Chat とも互換)。報告のあった「Feishu で ping は成功するのにメッセージが届かない」も修正 —— 形式の不一致に加え「HTTP 200 なら成功」と誤判定していたためで、プラットフォームの応答コードを解析し、実際の失敗は失敗として表示します。
- **公式 Discord ボット修正 + 複数チャンネル**:「ボットだけ設定して対応する Webhook がないとチャット/ボス通知が届かない」を修正。イベント通知を**複数ルート**化し、イベントごとに別チャンネルへ(例:チャットを専用チャンネルに)、または同じイベントを複数の Discord サーバーへ同時送信できます。
- **起動時に4人セーブの設定競合を検出**:協力プレイ(4人)のセーブを専用サーバーへ移すと `WorldOptions.sav` が残ることが多く、これが `PalWorldSettings.ini`(管理者パスワード含む)を上書きし、「設定が反映されない/プレイヤー一覧で管理者パスワード不一致」の原因になります。起動時にこれを検出して説明ダイアログを表示し、ワンクリックでファイルを退避(バックアップ・復元可能)してから起動を続行します。
- **パフォーマンスタブの再設計**:CPU をコア別/スレッド別に取得・正規化(総処理能力に対する割合)し、フレームタイムの推移を追加、3パネル構成を整列し直しました。

### 新機能・改善
- **ギルド拠点の削除**:ギルド詳細から PalDefender 経由で拠点をリアルタイム削除(サポーター先行、強い確認あり)。
- **マップ拠点のドリルダウン**:マップ上の拠点をクリックして「簡易 → 詳細 → ギルド」の情報を段階的に表示。
- **Docker 強化**:ARM64 イメージを追加、native でも Wine 強化に対応、イメージの自動 build/pull とデプロイ手順。
- **RCON / ログ修正**:RCON の中国語コマンドと Windows ログの文字化けを修正(Unicode 保持);Base64 RCON 設定をローカライズ。
- **プレイヤー一覧の修正**:オフラインプレイヤーの重複表示を修正、クロスプラットフォーム(Steam / Xbox…)のユーザー ID に対応。
- MOD ダウンロードが GitHub API のレート制限を回避;UE4SS 開発版(zDev)が「新バージョンあり」と誤表示しないように。

</details>
