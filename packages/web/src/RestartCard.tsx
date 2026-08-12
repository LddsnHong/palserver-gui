import { useCallback, useEffect, useState } from "react";
import { FiAlertTriangle, FiCheck, FiClock, FiCpu, FiPlus, FiRefreshCw, FiStar, FiX } from "react-icons/fi";
import { hasFeature } from "@palserver/shared";
import type { RestartPolicy, RestartStatus } from "@palserver/shared";
import type { AgentClient } from "./api";
import { t, useI18n } from "./i18n";
import { btn, btnGhost, card, errorCls, inputCls } from "./ui";

const fmtWhen = (iso: string) => new Date(iso).toLocaleString();

const REASON_LABELS: Record<string, string> = {
  scheduled: "定時",
  memory: "記憶體",
  crash: "崩潰",
  manual: "手動",
  update: "更新",
  "startup-failure": "啟動失敗",
};

/** agent 寫進重啟紀錄的 detail 是中文原文(含動態數值)。這裡比對已知模板、
 *  抽出動態值後用 t() 套譯文;比對不到(舊版格式等)原樣顯示 —— 與 i18n
 *  「查不到 key 就顯示中文原文」的 fallback 行為一致。模板來源:agent/src/supervisor.ts。 */
const DETAIL_PATTERNS: { re: RegExp; key: string; params: string[] }[] = [
  { re: /^已達排定的重啟時間$/, key: "已達排定的重啟時間", params: [] },
  { re: /^記憶體 (\S+) MB 持續超過 (\S+) MB$/, key: "記憶體 {mem} MB 持續超過 {limit} MB", params: ["mem", "limit"] },
  { re: /^一小時內已重啟 (\d+) 次,達到上限後停止自動重啟$/, key: "一小時內已重啟 {n} 次,達到上限後停止自動重啟", params: ["n"] },
  { re: /^伺服器異常結束,已自動重啟\(本小時第 (\d+) 次\)$/, key: "伺服器異常結束,已自動重啟(本小時第 {n} 次)", params: ["n"] },
  { re: /^自動重啟失敗:([\s\S]*)$/, key: "自動重啟失敗:{err}", params: ["err"] },
  { re: /^重啟失敗:([\s\S]*)$/, key: "重啟失敗:{err}", params: ["err"] },
];

const STARTUP_FAILURE_TEXT =
  "伺服器在啟動階段即結束,且 PalDefender 已開啟「啟動失敗時關閉伺服器」— 研判為 PalDefender 啟動失敗自我關閉,已停止自動重啟以免無限重啟迴圈。請查看 PalDefender 日誌修正原因,或關閉該選項與崩潰自動重啟其一。";

function localizeDetail(detail: string): string {
  if (detail.startsWith(STARTUP_FAILURE_TEXT)) {
    const hint = detail.slice(STARTUP_FAILURE_TEXT.length).match(/^ 最後日誌:([\s\S]*)$/);
    return t(STARTUP_FAILURE_TEXT) + (hint ? ` ${t("最後日誌:{hint}", { hint: hint[1] })}` : "");
  }
  for (const p of DETAIL_PATTERNS) {
    const m = detail.match(p.re);
    if (m) {
      const args: Record<string, string> = {};
      p.params.forEach((name, i) => {
        args[name] = m[i + 1];
      });
      return t(p.key, args);
    }
  }
  return detail;
}

/** Automatic-restart policy: scheduled, memory threshold, crash recovery. */
export function RestartCard({ client, instanceId }: { client: AgentClient; instanceId: string }) {
  useI18n();
  const [status, setStatus] = useState<RestartStatus | null>(null);
  const [draft, setDraft] = useState<RestartPolicy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [entitled, setEntitled] = useState<boolean | null>(null);
  // 排程 UI 是三選項(每隔一段時間/每天固定時間/每天固定多個時間),但 policy
  // schema 只有 interval/daily 兩種 mode —— 「單一 vs 多個」由 dailyTimes 長度
  // 區分;kindOverride 記住使用者點了「多個」但還只填一格的狀態。
  const [kindOverride, setKindOverride] = useState<"daily" | "daily-multi" | null>(null);

  useEffect(() => {
    client.license().then((l) => setEntitled(hasFeature("daily-restart", l))).catch(() => setEntitled(false));
  }, [client]);

  const refresh = useCallback(async () => {
    try {
      const next = await client.restartPolicy(instanceId);
      setStatus(next);
      setDraft((prev) => prev ?? next.policy);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client, instanceId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 15000);
    return () => clearInterval(timer);
  }, [refresh]);

  if (!status || !draft) return null;

  if (!status.supported) {
    return (
      <div className={card}>
        <h3 className="text-sm font-extrabold text-ink-muted">{t("伺服器重啟")}</h3>
        <p className="mt-1 text-[13px] text-ink-muted">{status.reason}</p>
      </div>
    );
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(status.policy);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      // 自動重啟的遊戲內倒數公告由 agent 端發送,agent 不知道介面語言 ——
      // 儲存時把「當下介面語言」的模板一併存進 policy,agent 只做佔位替換。
      await client.updateRestartPolicy(instanceId, {
        ...draft,
        // 「新增時刻」的空白欄位不送出(zod 會擋空字串)
        scheduled: { ...draft.scheduled, dailyTimes: draft.scheduled.dailyTimes.filter(Boolean) },
        announceTemplates: {
          restart: t("伺服器將在 {n} 秒後重新啟動({reason})"),
          reasonScheduled: t("排定重啟"),
          reasonMemory: t("記憶體超標"),
        },
      });
      setNotice(t("已儲存伺服器重啟設定"));
      setTimeout(() => setNotice(null), 3000);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const patch = (p: Partial<RestartPolicy>) => setDraft({ ...draft, ...p });

  return (
    <div className={`${card} flex flex-col gap-4`}>
      <div className="flex items-center justify-between gap-3">
        <h3 className="inline-flex items-center gap-2 text-sm font-extrabold">
          <FiRefreshCw className="size-4 text-pal" /> {t("伺服器重啟")}
        </h3>
        <span className="text-xs text-ink-muted">
          {status.memoryMB !== null && `${t("目前記憶體")} ${status.memoryMB} MB · `}
          {t("過去一小時重啟 {n} 次", { n: status.restartsLastHour })}
        </span>
      </div>

      {error && <p className={errorCls}>{error}</p>}
      {notice && (
        <p className="rounded-xl bg-grass/10 px-3 py-2 text-[13px] font-bold text-grass">{notice}</p>
      )}

      <Section
        icon={<FiRefreshCw className="size-4" />}
        title={t("偵測到新版本後自動更新")}
        enabled={draft.autoUpdate}
        onToggle={(enabled) => patch({ autoUpdate: enabled })}
      >
        <p className="text-xs text-ink-muted">
          {t("偵測到伺服器新版時,會先安全存檔、停止並下載新版,再自動啟動。")}
        </p>
      </Section>

      {/* 定時重啟 */}
      <Section
        icon={<FiClock className="size-4" />}
        title={t("定時重啟")}
        enabled={draft.scheduled.enabled}
        onToggle={(enabled) => patch({ scheduled: { ...draft.scheduled, enabled } })}
      >
        {(() => {
          // 三選項:interval / daily(單一時刻) / daily-multi(多時刻,贊助者限定)。
          const times = draft.scheduled.dailyTimes;
          const kind: "interval" | "daily" | "daily-multi" =
            draft.scheduled.mode === "interval"
              ? "interval"
              : times.length > 1
                ? "daily-multi"
                : (kindOverride ?? "daily");
          // 閘門上線前就已儲存多時刻的舊設定不鎖(grandfather,與 agent 端一致)
          const grandfathered =
            status.policy.scheduled.enabled &&
            status.policy.scheduled.mode === "daily" &&
            status.policy.scheduled.dailyTimes.length > 1;
          const multiLocked = entitled !== true && !grandfathered;
          const setTimes = (next: string[]) => {
            patch({ scheduled: { ...draft.scheduled, mode: "daily", dailyTimes: next } });
          };
          const OPTIONS = [
            { k: "interval" as const, label: t("每隔一段時間"), star: false, locked: false },
            { k: "daily" as const, label: t("每天固定時間"), star: false, locked: false },
            { k: "daily-multi" as const, label: t("每天固定多個時間"), star: true, locked: multiLocked },
          ];
          return (
            <>
              <div className="flex flex-wrap gap-2">
                {OPTIONS.map((o) => (
                  <button
                    key={o.k}
                    className={
                      (kind === o.k
                        ? "rounded-full bg-pal px-4 py-1.5 text-[13px] font-extrabold text-white"
                        : "rounded-full border-2 border-line bg-card-soft px-4 py-1.5 text-[13px] font-extrabold text-ink-muted transition hover:border-pal") +
                      (o.locked ? " opacity-50" : "")
                    }
                    disabled={o.locked}
                    title={o.locked ? t("此功能為贊助者專屬功能,可在設定頁輸入贊助者識別碼解鎖。") : undefined}
                    onClick={() => {
                      if (o.locked) return;
                      if (o.k === "interval") {
                        setKindOverride(null);
                        patch({ scheduled: { ...draft.scheduled, mode: "interval" } });
                      } else if (o.k === "daily") {
                        setKindOverride("daily");
                        setTimes(times.length ? [times[0]] : ["05:00"]);
                      } else {
                        setKindOverride("daily-multi");
                        setTimes(times.length ? times : ["05:00"]);
                      }
                    }}
                  >
                    {o.star ? (
                      <span className="inline-flex items-center gap-1.5">
                        <FiStar className={kind === o.k ? "size-3.5" : "size-3.5 text-pal"} />
                        {o.label}
                      </span>
                    ) : (
                      o.label
                    )}
                  </button>
                ))}
              </div>
              {multiLocked && (
                <p className="inline-flex items-start gap-1.5 text-[12px] leading-relaxed text-ink-muted">
                  <FiStar className="mt-0.5 size-3.5 shrink-0 text-pal" />
                  {t("免費版可設定 1 個時刻;多個時刻(如 00:00, 06:00, 12:00, 18:00)為贊助者專屬功能,可在設定頁輸入贊助者識別碼解鎖。")}
                </p>
              )}
              {kind === "interval" && (
                <Field label={t("每隔幾分鐘重啟")}>
                  <input
                    className={inputCls}
                    type="number"
                    min={15}
                    max={10080}
                    value={draft.scheduled.intervalMinutes}
                    onChange={(e) =>
                      patch({ scheduled: { ...draft.scheduled, intervalMinutes: Number(e.target.value) } })
                    }
                  />
                </Field>
              )}
              {kind === "daily" && (
                <Field label={t("每天的重啟時間")}>
                  <input
                    className={inputCls}
                    type="time"
                    value={times[0] ?? ""}
                    onChange={(e) => setTimes(e.target.value ? [e.target.value] : [])}
                  />
                </Field>
              )}
              {kind === "daily-multi" && (
                <Field label={t("每天的重啟時間")}>
                  <div className="flex flex-col gap-2">
                    {times.map((tm, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <input
                          className={inputCls}
                          type="time"
                          value={tm}
                          onChange={(e) => {
                            setKindOverride("daily-multi");
                            setTimes(times.map((x, j) => (j === i ? e.target.value : x)));
                          }}
                        />
                        {times.length > 1 && (
                          <button
                            className="rounded-lg p-1.5 text-ink-muted transition hover:bg-card-soft hover:text-ink"
                            title={t("移除此時刻")}
                            aria-label={t("移除此時刻")}
                            onClick={() => {
                              setKindOverride("daily-multi");
                              setTimes(times.filter((_, j) => j !== i));
                            }}
                          >
                            <FiX className="size-4" />
                          </button>
                        )}
                      </div>
                    ))}
                    {times.length < 12 && (
                      <button
                        className={`${btnGhost} inline-flex w-fit items-center gap-1.5`}
                        onClick={() => {
                          setKindOverride("daily-multi");
                          setTimes([...times, ""]);
                        }}
                      >
                        <FiPlus className="size-4 shrink-0" /> {t("新增時刻")}
                      </button>
                    )}
                  </div>
                </Field>
              )}
            </>
          );
        })()}
      </Section>

      {/* 記憶體閥值 */}
      <Section
        icon={<FiCpu className="size-4" />}
        title={t("記憶體超過閥值時重啟")}
        enabled={draft.memory.enabled}
        onToggle={(enabled) => patch({ memory: { ...draft.memory, enabled } })}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("閥值(MB)")}>
            <input
              className={inputCls}
              type="number"
              min={512}
              max={262144}
              value={draft.memory.thresholdMB}
              onChange={(e) => patch({ memory: { ...draft.memory, thresholdMB: Number(e.target.value) } })}
            />
          </Field>
          <Field label={t("連續超標幾次才重啟(每次間隔 30 秒)")}>
            <input
              className={inputCls}
              type="number"
              min={1}
              max={20}
              value={draft.memory.sustainedChecks}
              onChange={(e) =>
                patch({ memory: { ...draft.memory, sustainedChecks: Number(e.target.value) } })
              }
            />
          </Field>
        </div>
        <p className="text-xs text-ink-muted">
          {t("需連續超標才會動作,避免一時的記憶體尖峰誤觸發。")}
        </p>
      </Section>

      {/* 崩潰重啟 */}
      <Section
        icon={<FiAlertTriangle className="size-4" />}
        title={t("崩潰後自動重啟")}
        enabled={draft.crash.enabled}
        onToggle={(enabled) => patch({ crash: { ...draft.crash, enabled } })}
      >
        <Field label={t("每小時最多自動重啟次數(超過則停止嘗試)")}>
          <input
            className={inputCls}
            type="number"
            min={1}
            max={20}
            value={draft.crash.maxPerHour}
            onChange={(e) => patch({ crash: { ...draft.crash, maxPerHour: Number(e.target.value) } })}
          />
        </Field>
        <p className="text-xs text-ink-muted">
          {t("手動停止伺服器不會被視為崩潰。達到上限後會停止自動重啟,避免無限重啟迴圈。")}
        </p>
      </Section>

      <Field label={t("停止 / 重啟前的預告秒數(0 = 不預告)")}>
        <input
          className={`${inputCls} max-w-40`}
          type="number"
          min={0}
          max={300}
          value={draft.announceSeconds}
          onChange={(e) => patch({ announceSeconds: Number(e.target.value) })}
        />
      </Field>
      <p className="-mt-2 text-xs text-ink-muted">
        {t("計畫性重啟以及你手動按停止 / 重啟時,都會先在遊戲聊天室倒數公告這麼多秒,並在重啟前先存檔。公告使用介面語言;自動重啟的公告用你「儲存這份設定」當下的語言。崩潰重啟不預告(伺服器已經不在了)。")}
      </p>

      <div className="flex gap-2">
        <button className={btn} onClick={save} disabled={!dirty || saving}>
          {saving ? t("儲存中…") : t("儲存設定")}
        </button>
        {dirty && (
          <button className={btnGhost} onClick={() => setDraft(status.policy)} disabled={saving}>
            {t("重置")}
          </button>
        )}
      </div>

      {status.events.length > 0 && (
        <div>
          <h4 className="mb-2 text-sm font-extrabold text-ink-muted">{t("重啟紀錄")}</h4>
          <div className="flex max-h-56 flex-col divide-y divide-line overflow-y-auto">
            {status.events.map((e, i) => (
              <div key={`${e.at}-${i}`} className="flex items-start gap-2.5 py-2">
                {e.ok ? (
                  <FiCheck className="mt-0.5 size-4 shrink-0 text-grass" />
                ) : (
                  <FiX className="mt-0.5 size-4 shrink-0 text-berry" />
                )}
                <div className="flex-1">
                  <p className="text-[13px] font-bold">
                    {t(REASON_LABELS[e.reason] ?? e.reason)} · {localizeDetail(e.detail)}
                  </p>
                  <p className="text-xs text-ink-muted">{fmtWhen(e.at)}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Section({
  icon,
  title,
  enabled,
  onToggle,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border-2 border-line p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="inline-flex items-center gap-2 text-[13px] font-extrabold">
          <span className="text-pal">{icon}</span>
          {title}
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={title}
          onClick={() => onToggle(!enabled)}
          className={`relative h-6 w-11 shrink-0 rounded-full transition ${enabled ? "bg-grass" : "bg-line"}`}
        >
          <span
            className={`absolute top-1 size-4 rounded-full bg-white shadow transition-all ${enabled ? "left-6" : "left-1"}`}
          />
        </button>
      </div>
      {enabled && <div className="mt-3 flex flex-col gap-3">{children}</div>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-[13px] font-bold text-ink-muted">
      {label}
      {children}
    </label>
  );
}
