import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toFeishuPayload,
  toSlackPayload,
  toDiscordPayload,
  toMsgTypeTextPayload,
  toGoogleChatPayload,
  toTelegramPayload,
} from "./index.js";
import type { WebhookEnvelope } from "./index.js";

// issue #58:飞书/Slack 需要各自的訊息格式,送 generic/discord body 會被靜默丟棄。
// 這些測試鎖定新加的 payload builder 形狀 + 事件摘要有帶進去。

const env: WebhookEnvelope = {
  id: "evt_1",
  type: "player.join",
  specVersion: "1",
  instance: { id: "i1", name: "我的伺服器" },
  occurredAt: "2026-07-24T00:00:00.000Z",
  data: { name: "Alice" },
};

test("toFeishuPayload:飞书文字訊息 shape 正確(msg_type/content.text),帶伺服器名與事件摘要", () => {
  const p = toFeishuPayload(env);
  assert.equal(p.msg_type, "text");
  assert.equal(typeof p.content.text, "string");
  assert.ok(p.content.text.includes("我的伺服器"), "應含伺服器名");
  assert.ok(p.content.text.length > "[我的伺服器] ".length, "應含事件摘要文字,不只伺服器名");
});

test("toSlackPayload:Slack {text} shape 正確,帶伺服器名與事件摘要", () => {
  const p = toSlackPayload(env);
  assert.equal(typeof p.text, "string");
  assert.ok(p.text.includes("我的伺服器"), "應含伺服器名");
  assert.ok(p.text.length > "_我的伺服器_".length, "應含事件摘要文字");
});

test("toMsgTypeTextPayload:企業微信 / 钉钉 shape 正確(msgtype/text.content),帶伺服器名", () => {
  const p = toMsgTypeTextPayload(env);
  assert.equal(p.msgtype, "text");
  assert.equal(typeof p.text.content, "string");
  assert.ok(p.text.content.includes("我的伺服器"), "應含伺服器名");
});

test("toGoogleChatPayload:Google Chat {text} shape 正確,帶伺服器名", () => {
  const p = toGoogleChatPayload(env);
  assert.equal(typeof p.text, "string");
  assert.ok(p.text.includes("我的伺服器"), "應含伺服器名");
});

test("toTelegramPayload:Telegram {chat_id,text} shape 正確,帶入 chatId 與伺服器名", () => {
  const p = toTelegramPayload(env, "-1001234567890");
  assert.equal(p.chat_id, "-1001234567890");
  assert.equal(typeof p.text, "string");
  assert.ok(p.text.includes("我的伺服器"), "應含伺服器名");
});

test("toDiscordPayload:重構共用 eventSummary 後仍產出單一 embed(regression)", () => {
  const p = toDiscordPayload(env);
  assert.equal(Array.isArray(p.embeds), true);
  assert.equal(p.embeds.length, 1);
  const embed = p.embeds[0] as { footer?: { text?: string } };
  assert.equal(embed.footer?.text, "我的伺服器");
});
