# palserver GUI — v2.8.2

公會與玩家管理的一版:新增**公會荒廢偵測**(找出沒人的公會、安全清理其佔地據點),並修好**離線玩家名冊**——即使伺服器沒開、agent 重啟過,離線玩家也會從存檔完整顯示(等級、遊玩時長、上線天數、上下線紀錄)。
一个聚焦公会与玩家管理的版本:新增**公会荒废检测**,并修好**离线玩家名单**——即使服务器没开、agent 重启过,离线玩家也会从存档完整显示。
A guild & player management release: adds **inactive-guild detection** (find abandoned guilds and safely clear the bases they still occupy), and fixes the **offline player roster** — offline players now show fully from the save file even when the server is stopped or the agent was restarted.
ギルドとプレイヤー管理のリリース:**無人ギルド検出**を追加し、**オフラインプレイヤー名簿**を修正 —— サーバー停止中やエージェント再起動後でもセーブデータから完全に表示。

> 有開自動更新會自己抓,或依下方手動下載。
> The in-app updater fetches it automatically, or download below.
> 自動更新で取得、または下記から手動でダウンロード。

<details open>
<summary><b>🇹🇼 繁體中文</b></summary>

### 重點更新
- **公會荒廢偵測**:公會分頁可用天數篩選標出「無人公會」(所有成員都在 X 日內沒上線過)且還佔著據點的公會,依據點數與成員最近上線活躍度排序,一鍵引導到既有的安全刪除據點流程 —— 專治長期沒人、卻佔著地圖的廢棄公會。
- **離線玩家名冊修復**:離線玩家改以**存檔(SAV)為權威來源**。PalDefender 的即時名單只回在線玩家、而 agent 一重啟又會清掉暫存記錄,過去這兩件事湊在一起會讓離線玩家整批消失;現在直接從存檔讀出離線玩家(等級、遊玩時長、最後上線天數),**伺服器沒開也看得到、agent 重啟也不會不見**。
- **離線天數修正**:修好 `lastOnlineDaysAgo` 的基準誤判(改用存檔世界時鐘直接計算),離線天數不再溢位或顯示錯誤。

### 其他改進
- 上線資訊全域統一日期語意(以存檔推算的絕對日期為準);合併名冊後依上線時間重新排序(線上優先、最近上線在前)。
- 公會荒廢偵測、離線上線資訊四語 i18n 補齊。

</details>

<details>
<summary><b>🇨🇳 简体中文</b></summary>

### 重点更新
- **公会荒废检测**:公会页可用天数筛选标出「无人公会」(所有成员都在 X 天内没上线过)且还占着据点的公会,按据点数与成员最近上线活跃度排序,一键引导到既有的安全删除据点流程 —— 专治长期没人、却占着地图的废弃公会。
- **离线玩家名单修复**:离线玩家改以**存档(SAV)为权威来源**。PalDefender 的实时名单只返回在线玩家,而 agent 一重启又会清掉暂存记录,过去这两件事凑在一起会让离线玩家整批消失;现在直接从存档读出离线玩家(等级、游玩时长、最后上线天数),**服务器没开也看得到、agent 重启也不会不见**。
- **离线天数修正**:修好 `lastOnlineDaysAgo` 的基准误判(改用存档世界时钟直接计算),离线天数不再溢出或显示错误。

### 其他改进
- 上线信息全局统一日期语义(以存档推算的绝对日期为准);合并名单后按上线时间重新排序(在线优先、最近上线在前)。
- 公会荒废检测、离线上线信息四语 i18n 补齐。

</details>

<details>
<summary><b>🇺🇸 English</b></summary>

### Highlights
- **Inactive-guild detection**: the Guilds tab can flag "abandoned guilds" (no member online within the last X days) that still hold bases, sorted by base count and members' recent activity, with a one-click path into the existing safe base-deletion flow — for cleaning up long-dead guilds that still clutter the map.
- **Offline player roster fix**: offline players are now sourced authoritatively from the **save file**. PalDefender's live list only returns online players, and restarting the agent clears its in-memory presence log — together these used to make offline players vanish. They are now read straight from the save (level, playtime, last-online days), **visible even when the server is off and preserved across agent restarts**.
- **Last-online-days fix**: corrected the `lastOnlineDaysAgo` baseline (now computed from the save's in-game clock), so offline-day counts no longer overflow or show wrong values.

### Other improvements
- Unified date semantics for last-online info across the app (absolute date derived from the save); roster re-sorted by last-online time (online first, most-recent next).
- Four-language i18n for inactive-guild detection and last-online info.

</details>

<details>
<summary><b>🇯🇵 日本語</b></summary>

### 主なアップデート
- **無人ギルド検出**:ギルドタブで「無人ギルド」(全メンバーが過去 X 日以内に未ログイン)かつ拠点を保有しているギルドを日数フィルターで表示。拠点数とメンバーの直近アクティビティで並び替え、既存の安全な拠点削除フローへワンクリックで誘導 —— 長期放置でマップを占有するギルドの整理に。
- **オフラインプレイヤー名簿の修正**:オフラインプレイヤーを**セーブデータを正とする**方式に変更。PalDefender のライブ名簿はオンラインのみ返し、エージェント再起動で一時記録が消えるため、以前は両者が重なるとオフラインプレイヤーが一括で消えていました。現在はセーブから直接読み出し(レベル・プレイ時間・最終ログイン日数)、**サーバー停止中でも表示、エージェント再起動後も保持**。
- **最終ログイン日数の修正**:`lastOnlineDaysAgo` の基準誤りを修正(セーブのゲーム内時計から直接計算)、オフライン日数のオーバーフロー/誤表示を解消。

### その他の改善
- 最終ログイン情報の日付セマンティクスを全体で統一(セーブから算出した絶対日付);名簿を最終ログイン時刻で再ソート(オンライン優先、直近順)。
- 無人ギルド検出・最終ログイン情報の4言語 i18n。

</details>
