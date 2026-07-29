# palserver GUI — v2.8.3

小修:離線玩家的「最後上線」改用 agent 記錄的**精確時間**(含時分)顯示;只有存檔推算的才顯示日期,不再讓時分秒隨秒跳動、把幾天前上線誤顯示成「剛剛」。
A small fix: an offline player's "last online" now shows the **exact time** (with hour/minute) from the agent's own record; only save-derived values fall back to a date, so the timestamp no longer ticks by the second or mislabels a days-old login as "just now".
小さな修正:オフラインプレイヤーの「最終ログイン」をエージェント記録の**正確な時刻**(時分付き)で表示。セーブ由来のみ日付表示にフォールバックし、秒単位で変動して数日前のログインが「たった今」と誤表示されることがなくなりました。

> 有開自動更新會自己抓,或依下方手動下載。
> The in-app updater fetches it automatically, or download below.
> 自動更新で取得、または下記から手動でダウンロード。

<details open>
<summary><b>🇹🇼 繁體中文</b></summary>

### 修正
- **離線玩家「最後上線」時間**:優先改用 agent 自己記錄的精確時間(日期 + 時分,即真實最後上線);只有靠存檔天數推算的才退回顯示日期(整日精度),避免時分秒隨秒跳動,把幾天前的上線誤顯示成「現在」。承接 v2.8.2 的離線名冊修復。

</details>

<details>
<summary><b>🇨🇳 简体中文</b></summary>

### 修正
- **离线玩家「最后上线」时间**:优先改用 agent 自己记录的精确时间(日期 + 时分,即真实最后上线);只有靠存档天数推算的才退回显示日期(整日精度),避免时分秒随秒跳动,把几天前的上线误显示成「现在」。承接 v2.8.2 的离线名单修复。

</details>

<details>
<summary><b>🇺🇸 English</b></summary>

### Fix
- **Offline player "last online" time**: now prefers the exact timestamp from the agent's own record (date + time = the true last login); only save-day-estimated values fall back to a date-only display (whole-day precision), so the time no longer ticks by the second or mislabels a days-old login as "now". Follows up the v2.8.2 offline-roster fix.

</details>

<details>
<summary><b>🇯🇵 日本語</b></summary>

### 修正
- **オフラインプレイヤーの「最終ログイン」時刻**:エージェント自身の記録による正確な時刻(日付 + 時分 = 実際の最終ログイン)を優先表示。セーブの日数推定によるもののみ日付表示(日単位)にフォールバックし、秒単位で変動して数日前のログインが「現在」と誤表示されることを防止。v2.8.2 のオフライン名簿修正の続き。

</details>
