/**
 * Webhook 對外合約(agent 與 web、以及第三方 bot 共用的型別與常數)。
 *
 * 這份是「開發者合約」的真相來源:事件信封、事件型別、payload 形狀、訂閱比對規則。
 * 破壞性改動才升 specVersion 的 major;新增欄位 / 事件型別不升。
 */

import { localizeBossName, localizePalName, type BotLang } from "./game-names.js";

export const WEBHOOK_SPEC_VERSION = "1.0";

// ── 事件型別 ────────────────────────────────────────────────────────────

export type WebhookEventType =
  | "player.join"
  | "player.leave"
  | "player.chat"
  | "player.death"
  | "player.capture"
  | "server.starting"
  | "server.running"
  | "server.exited"
  | "server.crash"
  | "server.restart"
  | "server.startup_failure"
  | "server.update_available"
  | "boss.killed"
  | "boss.respawn"
  | "backup.completed"
  | "backup.failed"
  | "webhook.ping";

export interface WebhookEventDef {
  type: WebhookEventType;
  label: string;
  /** 事件來源是否需要額外環境(供 UI 標註,避免使用者以為必收得到)。 */
  requires?: "log" | "paldefender" | "boss-mod";
}

export interface WebhookEventGroup {
  namespace: string;
  label: string;
  events: WebhookEventDef[];
}

/** 事件目錄(UI 分組勾選 + 文件用)。 */
export const WEBHOOK_EVENT_CATALOG: WebhookEventGroup[] = [
  {
    namespace: "player",
    label: "玩家",
    events: [
      { type: "player.join", label: "玩家加入" },
      { type: "player.leave", label: "玩家離開" },
      { type: "player.chat", label: "聊天訊息", requires: "log" },
      { type: "player.death", label: "玩家死亡", requires: "log" },
      { type: "player.capture", label: "捕捉帕魯", requires: "log" },
    ],
  },
  {
    namespace: "server",
    label: "伺服器",
    events: [
      { type: "server.starting", label: "啟動中" },
      { type: "server.running", label: "已上線" },
      { type: "server.exited", label: "已停止" },
      { type: "server.crash", label: "崩潰" },
      { type: "server.restart", label: "重啟" },
      { type: "server.startup_failure", label: "啟動失敗" },
      { type: "server.update_available", label: "有新版本" },
    ],
  },
  {
    namespace: "boss",
    label: "頭目",
    events: [
      { type: "boss.killed", label: "頭目被擊殺", requires: "boss-mod" },
      { type: "boss.respawn", label: "頭目重生", requires: "boss-mod" },
    ],
  },
  {
    namespace: "backup",
    label: "備份",
    events: [
      { type: "backup.completed", label: "備份完成" },
      { type: "backup.failed", label: "備份失敗" },
    ],
  },
];

export const WEBHOOK_EVENT_TYPES: WebhookEventType[] = WEBHOOK_EVENT_CATALOG.flatMap((g) =>
  g.events.map((e) => e.type),
);

// ── 事件 payload(信封的 data 欄位) ────────────────────────────────────

export interface PlayerJoinData {
  userId: string;
  name: string;
  level?: number;
  ping?: number;
}
export interface PlayerLeaveData {
  userId: string;
  name: string;
}
export interface PlayerChatData {
  name: string;
  channel: string;
  message: string;
}
export interface PlayerDeathData {
  name: string;
  cause: string;
  /** 野生帕魯擊殺時的帕魯名。 */
  pal?: string;
}
export interface PlayerCaptureData {
  name: string;
  pal: string;
}
export interface ServerStatusData {
  status?: string;
  version?: string;
  code?: number;
  detail?: string;
}
export interface ServerRestartData {
  reason: "scheduled" | "memory" | "crash" | "manual" | "startup-failure";
  ok: boolean;
  detail?: string;
}
export interface ServerUpdateData {
  current: string;
  latest: string;
}
export interface BossEventData {
  bossId: string;
  /** spawner 代號(如 81_1_grass_FBOSS_4),非玩家可讀名稱 —— 顯示端請用 x/y 配對可讀名(localizeBossName)。 */
  name?: string;
  /** spawner 世界座標,供顯示端配對可讀頭目名(見 localizeBossName)。 */
  x?: number;
  y?: number;
}
export interface BackupEventData {
  path?: string;
  sizeBytes?: number;
  error?: string;
}

// ── 事件信封 ────────────────────────────────────────────────────────────

export interface WebhookEnvelope<T = unknown> {
  /** 唯一投遞 id;亦放進 X-Palserver-Delivery header,消費端拿來去重。 */
  id: string;
  type: WebhookEventType;
  specVersion: string;
  instance: { id: string; name: string };
  /** 事件發生時間(ISO8601)。 */
  occurredAt: string;
  data: T;
}

// ── Webhook 設定 ────────────────────────────────────────────────────────

export type WebhookFormat = "generic" | "discord" | "feishu" | "slack";

export interface WebhookConfig {
  id: string;
  label?: string;
  url: string;
  /** 訂閱的事件:精確型別、命名空間萬用字元(如 "player.*")或全部("*")。 */
  events: string[];
  format: WebhookFormat;
  enabled: boolean;
  createdAt: string;
  lastDelivery?: WebhookDeliveryResult;
}

/** 回給前端的形狀:不含 secret,只回是否已設。 */
export interface WebhookConfigPublic extends Omit<WebhookConfig, never> {
  secretSet: boolean;
}

export interface WebhookDeliveryResult {
  at: string;
  ok: boolean;
  status?: number;
  error?: string;
}

/** 送出日誌單筆(供 UI 除錯 / 手動重送)。 */
export interface WebhookDelivery extends WebhookDeliveryResult {
  deliveryId: string;
  event: WebhookEventType;
  attempts: number;
}

/** HMAC 簽章 header 名稱(常數化,避免 agent / bot 兩邊拼錯)。 */
export const WEBHOOK_HEADERS = {
  event: "X-Palserver-Event",
  delivery: "X-Palserver-Delivery",
  timestamp: "X-Palserver-Timestamp",
  signature: "X-Palserver-Signature",
} as const;

/**
 * 訂閱是否命中某事件型別。規則:
 *   "*"          → 全部
 *   "player.*"   → 該命名空間全部
 *   "player.chat"→ 精確
 */
export function eventMatches(subscriptions: string[], type: WebhookEventType): boolean {
  return subscriptions.some(
    (s) => s === "*" || s === type || (s.endsWith(".*") && type.startsWith(s.slice(0, -1))),
  );
}

const EVENT_COLOR: Partial<Record<WebhookEventType, number>> = {
  "player.join": 0x57d38c,
  "player.leave": 0x9aa4b2,
  "player.chat": 0x5fb0ff,
  "player.death": 0xff6b6b,
  "player.capture": 0xc792ea,
  "server.running": 0x57d38c,
  "server.exited": 0x9aa4b2,
  "server.crash": 0xff5c7a,
  "server.restart": 0xffcf5f,
  "server.startup_failure": 0xff5c7a,
  "boss.killed": 0xf1c40f,
  "boss.respawn": 0xf1c40f,
  "backup.completed": 0x57d38c,
  "backup.failed": 0xff6b6b,
  "webhook.ping": 0x888888,
};

/** 事件通知文字四語(webhook Discord 格式 / 同機 bot 通知共用)。key 對應 WebhookEventType。 */
type EventTextFn = (d: Record<string, unknown>, lang: BotLang) => { title: string; description: string };
const EVENT_TEXT: Record<string, Record<BotLang, EventTextFn>> = {
  "player.join": {
    en: (d) => ({ title: "Player joined", description: `**${str(d, "name")}** joined the server` }),
    ja: (d) => ({ title: "プレイヤー参加", description: `**${str(d, "name")}** がサーバーに参加しました` }),
    "zh-TW": (d) => ({ title: "玩家加入", description: `**${str(d, "name")}** 加入了伺服器` }),
    "zh-CN": (d) => ({ title: "玩家加入", description: `**${str(d, "name")}** 加入了服务器` }),
  },
  "player.leave": {
    en: (d) => ({ title: "Player left", description: `**${str(d, "name")}** left the server` }),
    ja: (d) => ({ title: "プレイヤー退出", description: `**${str(d, "name")}** がサーバーを退出しました` }),
    "zh-TW": (d) => ({ title: "玩家離開", description: `**${str(d, "name")}** 離開了伺服器` }),
    "zh-CN": (d) => ({ title: "玩家离开", description: `**${str(d, "name")}** 离开了服务器` }),
  },
  "player.chat": {
    en: (d) => ({ title: "Chat", description: `**${str(d, "name")}** [${str(d, "channel")}] ${str(d, "message")}` }),
    ja: (d) => ({ title: "チャット", description: `**${str(d, "name")}**〔${str(d, "channel")}〕${str(d, "message")}` }),
    "zh-TW": (d) => ({ title: "聊天", description: `**${str(d, "name")}**〔${str(d, "channel")}〕${str(d, "message")}` }),
    "zh-CN": (d) => ({ title: "聊天", description: `**${str(d, "name")}**〔${str(d, "channel")}〕${str(d, "message")}` }),
  },
  "player.death": {
    en: (d, lang) =>
      d.pal
        ? { title: "Player died", description: `**${str(d, "name")}** was killed by a wild ${localizePalName(str(d, "pal"), lang)}` }
        : { title: "Player died", description: `**${str(d, "name")}** died: ${str(d, "cause")}` },
    ja: (d, lang) =>
      d.pal
        ? { title: "プレイヤー死亡", description: `**${str(d, "name")}** が野生の${localizePalName(str(d, "pal"), lang)}に殺されました` }
        : { title: "プレイヤー死亡", description: `**${str(d, "name")}** が死亡:${str(d, "cause")}` },
    "zh-TW": (d, lang) =>
      d.pal
        ? { title: "玩家死亡", description: `**${str(d, "name")}** 被野生 ${localizePalName(str(d, "pal"), lang)} 擊殺` }
        : { title: "玩家死亡", description: `**${str(d, "name")}** 死亡:${str(d, "cause")}` },
    "zh-CN": (d, lang) =>
      d.pal
        ? { title: "玩家死亡", description: `**${str(d, "name")}** 被野生 ${localizePalName(str(d, "pal"), lang)} 击杀` }
        : { title: "玩家死亡", description: `**${str(d, "name")}** 死亡:${str(d, "cause")}` },
  },
  "player.capture": {
    en: (d, lang) => ({ title: "Pal captured", description: `**${str(d, "name")}** captured a ${localizePalName(str(d, "pal"), lang)}` }),
    ja: (d, lang) => ({ title: "パル捕獲", description: `**${str(d, "name")}** が${localizePalName(str(d, "pal"), lang)}を捕獲しました` }),
    "zh-TW": (d, lang) => ({ title: "捕捉帕魯", description: `**${str(d, "name")}** 捕捉了 ${localizePalName(str(d, "pal"), lang)}` }),
    "zh-CN": (d, lang) => ({ title: "捕捉帕鲁", description: `**${str(d, "name")}** 捕捉了 ${localizePalName(str(d, "pal"), lang)}` }),
  },
  "server.starting": {
    en: () => ({ title: "Server starting", description: "" }),
    ja: () => ({ title: "サーバー起動中", description: "" }),
    "zh-TW": () => ({ title: "伺服器啟動中", description: "" }),
    "zh-CN": () => ({ title: "服务器启动中", description: "" }),
  },
  "server.running": {
    en: (d) => ({ title: "Server online", description: str(d, "version") }),
    ja: (d) => ({ title: "サーバー稼働中", description: str(d, "version") }),
    "zh-TW": (d) => ({ title: "伺服器已上線", description: str(d, "version") }),
    "zh-CN": (d) => ({ title: "服务器已上线", description: str(d, "version") }),
  },
  "server.exited": {
    en: () => ({ title: "Server stopped", description: "" }),
    ja: () => ({ title: "サーバー停止", description: "" }),
    "zh-TW": () => ({ title: "伺服器已停止", description: "" }),
    "zh-CN": () => ({ title: "服务器已停止", description: "" }),
  },
  "server.crash": {
    en: (d) => ({ title: "Server crashed", description: str(d, "detail") }),
    ja: (d) => ({ title: "サーバークラッシュ", description: str(d, "detail") }),
    "zh-TW": (d) => ({ title: "伺服器崩潰", description: str(d, "detail") }),
    "zh-CN": (d) => ({ title: "服务器崩溃", description: str(d, "detail") }),
  },
  "server.restart": {
    en: (d) => ({ title: "Server restarted", description: `Reason: ${str(d, "reason")} (${d.ok ? "ok" : "failed"})` }),
    ja: (d) => ({ title: "サーバー再起動", description: `理由:${str(d, "reason")}(${d.ok ? "成功" : "失敗"})` }),
    "zh-TW": (d) => ({ title: "伺服器重啟", description: `原因:${str(d, "reason")}(${d.ok ? "成功" : "失敗"})` }),
    "zh-CN": (d) => ({ title: "服务器重启", description: `原因:${str(d, "reason")}(${d.ok ? "成功" : "失败"})` }),
  },
  "server.startup_failure": {
    en: (d) => ({ title: "Startup failed", description: str(d, "detail") }),
    ja: (d) => ({ title: "起動失敗", description: str(d, "detail") }),
    "zh-TW": (d) => ({ title: "啟動失敗", description: str(d, "detail") }),
    "zh-CN": (d) => ({ title: "启动失败", description: str(d, "detail") }),
  },
  "server.update_available": {
    en: (d) => ({
      title: "Update available",
      description: str(d, "latest") ? `${str(d, "current")} → ${str(d, "latest")}` : `Current ${str(d, "current")}, update available`,
    }),
    ja: (d) => ({
      title: "新しいバージョンがあります",
      description: str(d, "latest") ? `${str(d, "current")} → ${str(d, "latest")}` : `現在 ${str(d, "current")}、更新可能`,
    }),
    "zh-TW": (d) => ({
      title: "有新版本",
      description: str(d, "latest") ? `${str(d, "current")} → ${str(d, "latest")}` : `目前 ${str(d, "current")},有可用更新`,
    }),
    "zh-CN": (d) => ({
      title: "有新版本",
      description: str(d, "latest") ? `${str(d, "current")} → ${str(d, "latest")}` : `目前 ${str(d, "current")},有可用更新`,
    }),
  },
  "boss.killed": {
    en: (d) => ({ title: "Boss defeated", description: bossLabel(d, "en") }),
    ja: (d) => ({ title: "ボス討伐", description: bossLabel(d, "ja") }),
    "zh-TW": (d) => ({ title: "頭目被擊殺", description: bossLabel(d, "zh-TW") }),
    "zh-CN": (d) => ({ title: "头目被击杀", description: bossLabel(d, "zh-CN") }),
  },
  "boss.respawn": {
    en: (d) => ({ title: "Boss respawned", description: bossLabel(d, "en") }),
    ja: (d) => ({ title: "ボスリスポーン", description: bossLabel(d, "ja") }),
    "zh-TW": (d) => ({ title: "頭目重生", description: bossLabel(d, "zh-TW") }),
    "zh-CN": (d) => ({ title: "头目重生", description: bossLabel(d, "zh-CN") }),
  },
  "backup.completed": {
    en: (d) => ({ title: "Backup completed", description: str(d, "path") }),
    ja: (d) => ({ title: "バックアップ完了", description: str(d, "path") }),
    "zh-TW": (d) => ({ title: "備份完成", description: str(d, "path") }),
    "zh-CN": (d) => ({ title: "备份完成", description: str(d, "path") }),
  },
  "backup.failed": {
    en: (d) => ({ title: "Backup failed", description: str(d, "error") }),
    ja: (d) => ({ title: "バックアップ失敗", description: str(d, "error") }),
    "zh-TW": (d) => ({ title: "備份失敗", description: str(d, "error") }),
    "zh-CN": (d) => ({ title: "备份失败", description: str(d, "error") }),
  },
  "webhook.ping": {
    en: () => ({ title: "Webhook test", description: "Setup succeeded — this is a test message." }),
    ja: () => ({ title: "Webhook テスト", description: "設定に成功しました。これはテストメッセージです。" }),
    "zh-TW": () => ({ title: "Webhook 測試", description: "設定成功,這是一則測試訊息。" }),
    "zh-CN": () => ({ title: "Webhook 测试", description: "设置成功,这是一条测试消息。" }),
  },
};

function str(d: Record<string, unknown>, k: string): string {
  return typeof d[k] === "string" ? (d[k] as string) : "";
}

/** boss.* 事件的顯示名:優先用座標配對可讀頭目名(localizeBossName),配不到就退回 spawner 代號。 */
function bossLabel(d: Record<string, unknown>, lang: BotLang): string {
  const x = typeof d.x === "number" ? d.x : undefined;
  const y = typeof d.y === "number" ? d.y : undefined;
  const named = x !== undefined && y !== undefined ? localizeBossName(x, y, lang) : null;
  return named ?? str(d, "name") ?? str(d, "bossId");
}

/** 把事件信封轉成 Discord embed payload({embeds:[…]})。agent(webhook format:discord)與官方
 *  bot(同機通知)共用同一份渲染,確保兩條路徑的訊息一致。純函式,不簽章。
 *  lang 預設 zh-TW(webhook 系統目前無語言設定,維持既有行為);bot 通知會帶使用者設定的語言。 */
export function toDiscordPayload(env: WebhookEnvelope, lang: BotLang = "zh-TW"): { embeds: unknown[] } {
  const t = eventSummary(env, lang);
  return {
    embeds: [
      {
        title: t.title,
        description: t.description || undefined,
        color: EVENT_COLOR[env.type] ?? 0x5865f2,
        timestamp: env.occurredAt,
        footer: { text: env.instance.name },
      },
    ],
  };
}

/** 事件 → 一段「標題 / 說明」摘要(discord embed 與飞书/Slack 純文字訊息共用同一份四語渲染)。 */
function eventSummary(env: WebhookEnvelope, lang: BotLang): { title: string; description: string } {
  const d = env.data as Record<string, unknown>;
  const build = EVENT_TEXT[env.type]?.[lang];
  return build ? build(d, lang) : { title: env.type, description: "" };
}

/** 把事件信封轉成飞书(Lark)自訂機器人的文字訊息 payload。飞书只吃 {msg_type, content},
 *  送 generic/discord 格式它會回 HTTP 200 但 code≠0 靜默丟棄(見 issue #58)。 */
export function toFeishuPayload(
  env: WebhookEnvelope,
  lang: BotLang = "zh-TW",
): { msg_type: "text"; content: { text: string } } {
  const s = eventSummary(env, lang);
  const text = [`[${env.instance.name}] ${s.title}`, s.description].filter(Boolean).join("\n");
  return { msg_type: "text", content: { text } };
}

/** 把事件信封轉成 Slack incoming webhook 的文字訊息 payload({text},支援 mrkdwn)。 */
export function toSlackPayload(env: WebhookEnvelope, lang: BotLang = "zh-TW"): { text: string } {
  const s = eventSummary(env, lang);
  const text = [`*${s.title}*`, s.description, `_${env.instance.name}_`].filter(Boolean).join("\n");
  return { text };
}
