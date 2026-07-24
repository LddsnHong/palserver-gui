import fs from "node:fs";
import type { Readable } from "node:stream";
import { parserStream } from "stream-json";
import type { Token } from "stream-json/parser.js";
import type {
  SaveGuild,
  SaveHealthCounts,
  SaveHealthPlayerRow,
  SaveItemStack,
  SavePalRow,
  SavePlayerInventory,
  SavePlayerProfile,
} from "@palserver/shared";

/**
 * Level.sav JSON(palsav convert --to-json 的輸出)串流分析器。
 *
 * 大型世界的 JSON 可能有數 GB,V8 的字串上限與記憶體都吃不下 JSON.parse ——
 * 所以走 token 級串流:自維護 path stack,只在「單一元素」(一個公會、一個容器)
 * 的粒度累積臨時狀態,任何 Section 都不整棵組回記憶體。
 *
 * 欄位路徑依據上游 palsav(pin 2c8c65c)的 diag.py 與 rawdata/group.py,
 * 詳見 .claude/notes/save-slim-impl.md 第 1 節。
 */

export interface LevelJsonAnalysis {
  counts: SaveHealthCounts;
  inactivePlayers: SaveHealthPlayerRow[];
  emptyGuildNames: string[];
  /** 玩家快照(玩家詳情頁用):等級/公會/最後上線 + 名下帕魯明細。 */
  players: SavePlayerProfile[];
  /** 公會完整檔案(公會頁用);storage 為 null,由二趟掃描補。 */
  guilds: SaveGuild[];
  /** 據點工作容器中的完整帕魯個體。 */
  basePals: SavePalRow[];
  /** 公會 id(hex)→ 倉庫容器 id(二趟掃描的目標清單)。 */
  guildStorageContainers: Map<string, string>;
  /** worldSaveData 頂層 section 清單(診斷:判斷某類資料是否存在於存檔)。 */
  worldSections: string[];
}

export type InventoryKind = keyof Omit<SavePlayerInventory, "money">;

export interface AnalyzeOptions {
  /** 容器 id(純 hex 小寫)→ 種類。由 Players/*.sav 解析而來
   *  (OtomoCharacterContainerId = party、PalStorageContainerId = palbox),
   *  帕魯依所在容器分類;沒給就全部 unknown。 */
  containerKinds?: Map<string, "party" | "palbox">;
  /** 物品容器 id(純 hex 小寫)→ 誰的哪一格(背包/裝備/…)。
   *  掃描時會把這些容器的內容收進玩家快照的 inventory。 */
  itemContainerOwners?: Map<string, { uid: string; kind: InventoryKind }>;
  /** 玩家 uid(純 hex 小寫)→ 其 Players/<uid>.sav 檔案 mtimeMs(最後上線現實時間)。
   *  last_online_real_time 基準在本環境不適用(見 G2),改以此算離線天數。 */
  playerSavMtimes?: Map<string, number>;
}

/** GUID 正規化成純 hex 小寫(容器 id 比對用)。 */
export const normGuid = (s: string): string => s.replace(/[^0-9a-f]/gi, "").toLowerCase();

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
/** 單一玩家保留的帕魯明細上限(palCount 仍是真實總數)。 */
const MAX_PALS_PER_PLAYER = 1000;
/** 單一角色容器保留上限;據點工作數可由伺服器設定提高,需高於遊戲預設值。 */
const MAX_PALS_PER_CONTAINER = 100;

/** FDateTime ticks(100ns,自 0001-01-01)→ Unix epoch 的偏移。 */
const EPOCH_TICKS = 621_355_968_000_000_000;
const TICKS_PER_DAY = 864_000_000_000;
/** 換算出的離線天數超出這個範圍就視為時鐘基準不符,回報 null(不硬湊)。 */
const MAX_PLAUSIBLE_DAYS = 3650;

const INACTIVE_DAYS = 30;

/** 由 player .sav 檔案 mtime 算離線天數(現實時間基準,與 Date.now() 一致)。uid 純 hex 小寫比對。 */
const daysAgoFromSav = (uid: string, savMtimes?: Map<string, number>): number | null => {
  const m = savMtimes?.get(normGuid(uid));
  if (!m) return null;
  const d = Math.floor((Date.now() - m) / 86_400_000);
  return d >= 0 && d <= MAX_PLAUSIBLE_DAYS ? d : null;
};
const MAX_INACTIVE_ROWS = 100;
const MAX_EMPTY_GUILD_NAMES = 50;
/** 單一物品清單(背包/裝備/…)保留的品項上限。 */
const MAX_ITEMS_PER_LIST = 500;

const GUILD_TYPE = "EPalGroupType::Guild";

type Section =
  | "CharacterSaveParameterMap"
  | "GroupSaveDataMap"
  | "ItemContainerSaveData"
  | "CharacterContainerSaveData"
  | "MapObjectSaveData"
  | "DynamicItemSaveData"
  | "BaseCampSaveData"
  | "GuildExtraSaveDataMap";

const SECTIONS = new Set<string>([
  "CharacterSaveParameterMap",
  "GroupSaveDataMap",
  "ItemContainerSaveData",
  "CharacterContainerSaveData",
  "MapObjectSaveData",
  "DynamicItemSaveData",
  "BaseCampSaveData",
  "GuildExtraSaveDataMap",
]);

interface RosterEntry {
  uid?: string;
  name?: string;
  ticks?: number;
}

/** 正在掃描中的單一 Section 元素(同一時間最多一個,JSON 是線性的)。 */
interface ElementCtx {
  section: Section;
  /** 元素物件展開當下的 path 深度,用來配對它的 endObject 與計算相對路徑。 */
  depth: number;
  isPlayer?: boolean;
  groupType?: string;
  guildName?: string;
  roster?: Map<number, RosterEntry>;
  /* GroupSaveDataMap 公會擴充欄位 */
  groupId?: string;
  adminUid?: string;
  baseCampLevel?: number;
  baseIds?: string[];
  /* BaseCampSaveData 元素 */
  baseId?: string;
  baseName?: string;
  baseX?: number;
  baseY?: number;
  workerContainerId?: string;
  /* GuildExtraSaveDataMap 元素(公會倉庫容器 + 研究) */
  extraGuildId?: string;
  storageContainerId?: string;
  researchEntries?: { id: string; workAmount: number }[];
  pendingResearchId?: string;
  currentResearchId?: string;
  /* 玩家加點(GotStatusPointList / GotExStatusPointList) */
  statusPoints?: Map<string, number>;
  pendingStatusName?: string;
  unusedStatusPoints?: number;
  slotNum?: number;
  hasItem?: boolean;
  mapObjectId?: string;
  /* ItemContainerSaveData 元素:是玩家物品容器時收內容 */
  keyContainerId?: string;
  invOwner?: { uid: string; kind: InventoryKind };
  pendingCount?: number;
  items?: SaveItemStack[];
  /* CharacterSaveParameterMap 元素的欄位收集(玩家快照用) */
  keyPlayerUid?: string;
  keyInstanceId?: string;
  containerId?: string;
  slotIndex?: number;
  nickName?: string;
  levelNum?: number;
  expNum?: number;
  ownerUid?: string;
  characterId?: string;
  gender?: string;
  rank?: number;
  isLucky?: boolean;
  talentHp?: number;
  talentShot?: number;
  talentDefense?: number;
  passives?: string[];
}

class Analyzer {
  constructor(private readonly opts: AnalyzeOptions = {}) {}

  private readonly path: (string | number)[] = [];
  private readonly containers: ("obj" | "arr")[] = [];
  private readonly arrIndex: number[] = [];
  private pendingKey: string | null = null;
  private elem: ElementCtx | null = null;

  readonly counts: SaveHealthCounts = {
    players: 0,
    playersInactive30d: 0,
    pals: 0,
    guilds: 0,
    guildsEmpty: 0,
    itemContainers: 0,
    itemContainersEmpty: 0,
    itemSlots: 0,
    charContainers: 0,
    mapObjects: 0,
    dropItems: 0,
    dynamicItems: 0,
  };
  readonly emptyGuildNames: string[] = [];
  /** uid → 名冊資料(跨公會取最近一次上線)。 */
  readonly playersSeen = new Map<string, { name: string; guildName: string; ticks: number }>();
  private charEntries = 0;
  /** uid → 玩家角色資料(來自 CharacterSaveParameterMap 的玩家 entry)。 */
  private readonly playerChars = new Map<
    string,
    {
      name: string;
      level: number | null;
      exp: number | null;
      statusPoints: { name: string; points: number }[];
      unusedStatusPoints: number | null;
    }
  >();
  /** 公會清單(含據點 id 與會長)與據點座標。 */
  private readonly guilds: {
    groupId: string;
    name: string;
    adminUid: string | null;
    baseCampLevel: number | null;
    baseIds: string[];
    memberUids: string[];
  }[] = [];
  private readonly baseCamps: {
    id: string;
    name: string;
    groupId: string;
    x: number;
    y: number;
    workerContainerId: string;
  }[] = [];
  /** 容器 → 完整帕魯索引(據點駐守與配種反查用;每容器上限防爆)。 */
  private readonly palsByContainer = new Map<string, SavePalRow[]>();
  /** 公會 id → 倉庫容器/研究(GuildExtraSaveDataMap)。 */
  private readonly guildExtras = new Map<
    string,
    { storageContainerId: string | null; research: SaveGuild["research"] }
  >();
  /** worldSaveData 頂層 section 名稱(診斷用)。 */
  readonly worldSections = new Set<string>();
  /** ownerUid → 名下帕魯明細。 */
  private readonly palsByOwner = new Map<string, { rows: SavePalRow[]; total: number }>();
  /** uid → 離線物品(玩家容器內容彙整)。 */
  private readonly inventories = new Map<string, SavePlayerInventory>();

  /** 給 collectContainerContents 取回收集結果用。 */
  inventoriesView(): ReadonlyMap<string, SavePlayerInventory> {
    return this.inventories;
  }

  private getInventory(uid: string): SavePlayerInventory {
    let inv = this.inventories.get(uid);
    if (!inv) {
      inv = { money: 0, common: [], essential: [], weapons: [], armor: [], food: [] };
      this.inventories.set(uid, inv);
    }
    return inv;
  }
  /** 存檔內的世界時鐘(GameTimeSaveData.RealDateTimeTicks)——上游清理工具
   *  以它為「現在」計算離線天數;拿得到就優先用,mtime 只當 fallback。 */
  private realDateTimeTicks: number | null = null;

  /** 值開始:把自己在容器裡的位置(key 或 array index)推進 path。 */
  private beginValue(): void {
    const top = this.containers[this.containers.length - 1];
    if (top === "obj") {
      this.path.push(this.pendingKey ?? "");
      this.pendingKey = null;
      // worldSaveData.value 的直接子鍵 = 存檔的頂層 section(診斷清單)
      const p = this.path;
      if (p.length === 4 && p[0] === "properties" && p[1] === "worldSaveData" && p[2] === "value") {
        this.worldSections.add(p[3] as string);
      }
    } else if (top === "arr") {
      this.path.push(this.arrIndex[this.arrIndex.length - 1]++);
    }
    // 根值:path 不推東西
  }

  private endValue(): void {
    if (this.containers.length > 0 || this.path.length > 0) this.path.pop();
  }

  token(t: Token): void {
    switch (t.name) {
      case "keyValue":
        this.pendingKey = t.value;
        break;
      case "startObject":
        this.beginValue();
        this.maybeStartElement();
        this.containers.push("obj");
        break;
      case "endObject":
        this.containers.pop();
        this.maybeEndElement();
        this.endValue();
        break;
      case "startArray":
        this.beginValue();
        this.containers.push("arr");
        this.arrIndex.push(0);
        break;
      case "endArray":
        this.containers.pop();
        this.arrIndex.pop();
        this.endValue();
        break;
      case "stringValue":
      case "numberValue":
      case "trueValue":
      case "falseValue":
      case "nullValue":
        this.beginValue();
        this.scalar(t);
        this.endValue();
        break;
      default:
        break; // stringChunk 等串流 token 已用 streamValues:false 關掉
    }
  }

  /** Section 元素形狀:properties.worldSaveData.value.<S>.value[i](Map 型)
   *  或 properties.worldSaveData.value.<S>.value.values[i](Array 型)。
   *  兩種都註冊,實際只會出現其中一種。 */
  private maybeStartElement(): void {
    const p = this.path;
    const isWorldPrefix =
      p[0] === "properties" && p[1] === "worldSaveData" && p[2] === "value" && p[4] === "value";
    if (!isWorldPrefix || typeof p[3] !== "string" || !SECTIONS.has(p[3])) return;
    const mapShape = p.length === 6 && typeof p[5] === "number";
    const arrShape = p.length === 7 && p[5] === "values" && typeof p[6] === "number";
    if (!mapShape && !arrShape) return;
    this.elem = { section: p[3] as Section, depth: p.length };
  }

  private maybeEndElement(): void {
    const e = this.elem;
    if (!e || this.path.length !== e.depth) return;
    this.elem = null;
    const c = this.counts;
    switch (e.section) {
      case "CharacterSaveParameterMap":
        this.charEntries += 1;
        if (e.isPlayer) {
          c.players += 1;
          if (e.keyPlayerUid && e.keyPlayerUid !== ZERO_UUID) {
            // 同一 uid 可能有多個玩家實體(共玩匯入/host-fix 的殘影,實機踩過:
            // 真身有 Level/Exp,殘影沒有;檔內順序不定)——欄位較全者優先,
            // 新實體缺 Level 就保留已收到的等級/經驗,不讓殘影蓋掉真身。
            const prev = this.playerChars.get(e.keyPlayerUid);
            const stale = e.levelNum == null && prev !== undefined;
            const points = [...(e.statusPoints ?? new Map()).entries()].map(([name, points]) => ({ name, points }));
            this.playerChars.set(e.keyPlayerUid, {
              name: e.nickName || prev?.name || "?",
              // UE 序列化會省略預設值:等級 1/經驗 0 的角色根本沒有這兩個欄位,
              // 實體有解析到就補預設,不然新角色會顯示「無等級」(實機踩過)。
              level: stale ? prev.level : e.levelNum ?? 1,
              exp: stale ? prev.exp : e.expNum ?? 0,
              statusPoints: stale && points.length === 0 ? prev.statusPoints : points,
              unusedStatusPoints: stale ? prev.unusedStatusPoints : e.unusedStatusPoints ?? null,
            });
          }
        }
        // 容器→完整帕魯索引:玩家以外全收(含無主的據點工作帕魯),駐守與配種反查用
        if (!e.isPlayer && e.characterId && e.containerId) {
          const key = normGuid(e.containerId);
          const list = this.palsByContainer.get(key) ?? [];
          if (list.length < MAX_PALS_PER_CONTAINER) {
            list.push(this.palRow(e, "base"));
            this.palsByContainer.set(key, list);
          }
        }
        if (!e.isPlayer && e.ownerUid && e.ownerUid !== ZERO_UUID && e.characterId) {
          let bucket = this.palsByOwner.get(e.ownerUid);
          if (!bucket) {
            bucket = { rows: [], total: 0 };
            this.palsByOwner.set(e.ownerUid, bucket);
          }
          bucket.total += 1;
          if (bucket.rows.length < MAX_PALS_PER_PLAYER) {
            const kinds = this.opts.containerKinds;
            const kind = e.containerId ? kinds?.get(normGuid(e.containerId)) : undefined;
            bucket.rows.push(this.palRow(e, kind ?? (kinds && kinds.size > 0 && e.containerId ? "base" : "unknown")));
          }
        }
        c.pals = this.charEntries - c.players;
        break;
      case "GroupSaveDataMap": {
        if (e.groupType !== GUILD_TYPE) break;
        c.guilds += 1;
        const roster = e.roster ? [...e.roster.values()] : [];
        this.guilds.push({
          groupId: e.groupId ?? "",
          name: e.guildName || "(未命名公會)",
          adminUid: e.adminUid ?? null,
          baseCampLevel: e.baseCampLevel ?? null,
          baseIds: e.baseIds ?? [],
          memberUids: roster.map((m) => m.uid).filter((u): u is string => !!u),
        });
        if (roster.length === 0) {
          c.guildsEmpty += 1;
          if (this.emptyGuildNames.length < MAX_EMPTY_GUILD_NAMES) {
            this.emptyGuildNames.push(e.guildName || "(未命名公會)");
          }
          break;
        }
        for (const m of roster) {
          if (!m.uid) continue;
          const prev = this.playersSeen.get(m.uid);
          const ticks = m.ticks ?? 0;
          if (!prev || ticks > prev.ticks) {
            this.playersSeen.set(m.uid, {
              name: m.name || prev?.name || "?",
              guildName: e.guildName || "?",
              ticks,
            });
          }
        }
        break;
      }
      case "ItemContainerSaveData":
        c.itemContainers += 1;
        c.itemSlots += e.slotNum ?? 0;
        if (!e.hasItem) c.itemContainersEmpty += 1;
        if (e.invOwner) {
          const inv = this.getInventory(e.invOwner.uid);
          for (const s of e.items ?? []) {
            if (s.itemId === "Money") inv.money += s.count;
            else if (inv[e.invOwner.kind].length < MAX_ITEMS_PER_LIST) inv[e.invOwner.kind].push(s);
          }
        }
        break;
      case "CharacterContainerSaveData":
        c.charContainers += 1;
        break;
      case "MapObjectSaveData":
        c.mapObjects += 1;
        if (e.mapObjectId && /dropitem/i.test(e.mapObjectId)) c.dropItems += 1;
        break;
      case "DynamicItemSaveData":
        c.dynamicItems += 1;
        break;
      case "BaseCampSaveData":
        if (e.baseId) {
          this.baseCamps.push({
            id: e.baseId,
            name: e.baseName ?? "",
            groupId: e.groupId ?? "",
            x: e.baseX ?? 0,
            y: e.baseY ?? 0,
            workerContainerId: e.workerContainerId ?? "",
          });
        }
        break;
      case "GuildExtraSaveDataMap":
        if (e.extraGuildId) {
          this.guildExtras.set(normGuid(e.extraGuildId), {
            storageContainerId: e.storageContainerId ?? null,
            research:
              e.researchEntries || e.currentResearchId
                ? {
                    currentId: e.currentResearchId && e.currentResearchId !== "None" ? e.currentResearchId : null,
                    entries: e.researchEntries ?? [],
                  }
                : null,
          });
        }
        break;
    }
  }

  private palRow(e: ElementCtx, location: SavePalRow["location"]): SavePalRow {
    const characterId = e.characterId ?? "";
    return {
      instanceId: e.keyInstanceId ?? "",
      location,
      slotIndex: e.slotIndex,
      characterId,
      nickname: e.nickName || undefined,
      // UE 會省略預設值:沒欄位 = 等級 1、IV 0。
      level: e.levelNum ?? 1,
      gender: e.gender === "EPalGenderType::Female" ? "female" : e.gender === "EPalGenderType::Male" ? "male" : null,
      rank: e.rank ?? 0,
      isLucky: e.isLucky ?? false,
      isBoss: characterId.toUpperCase().startsWith("BOSS_"),
      talentHp: e.talentHp ?? 0,
      talentShot: e.talentShot ?? 0,
      talentDefense: e.talentDefense ?? 0,
      passives: e.passives ?? [],
    };
  }

  private scalar(t: Token & { value?: unknown }): void {
    if (t.name === "numberValue" && this.realDateTimeTicks === null) {
      const p = this.path;
      if (
        p.length === 7 &&
        p[0] === "properties" &&
        p[1] === "worldSaveData" &&
        p[2] === "value" &&
        p[3] === "GameTimeSaveData" &&
        p[4] === "value" &&
        p[5] === "RealDateTimeTicks" &&
        p[6] === "value"
      ) {
        this.realDateTimeTicks = Number(t.value);
        return;
      }
    }
    const e = this.elem;
    if (!e) return;
    const rel = this.path.slice(e.depth);
    const last = rel[rel.length - 1];
    const prev = rel[rel.length - 2];
    switch (e.section) {
      case "CharacterSaveParameterMap": {
        if (prev === "IsPlayer" && last === "value" && t.name === "trueValue") {
          e.isPlayer = true;
          break;
        }
        // 元素 key:{"key":{"PlayerUId":{"value":uuid},...}}
        if (rel[0] === "key" && prev === "PlayerUId" && last === "value" && t.name === "stringValue") {
          e.keyPlayerUid = t.value as string;
          break;
        }
        if (rel[0] === "key" && prev === "InstanceId" && last === "value" && t.name === "stringValue") {
          e.keyInstanceId = t.value as string;
          break;
        }
        // 所在容器:SaveParameter.value.SlotId.value.ContainerId.value.ID.value
        if (prev === "ID" && last === "value" && t.name === "stringValue" && rel.includes("SlotId")) {
          e.containerId ??= t.value as string;
          break;
        }
        if (prev === "SlotIndex" && last === "value" && t.name === "numberValue" && rel.includes("SlotId")) {
          e.slotIndex = Number(t.value);
          break;
        }
        // 加點:GotStatusPointList / GotExStatusPointList 的 {StatusName, StatusPoint} 序列
        if (rel.includes("GotStatusPointList") || rel.includes("GotExStatusPointList")) {
          if (prev === "StatusName" && last === "value" && t.name === "stringValue") {
            e.pendingStatusName = t.value as string;
          } else if (prev === "StatusPoint" && last === "value" && t.name === "numberValue" && e.pendingStatusName) {
            const m = (e.statusPoints ??= new Map());
            m.set(e.pendingStatusName, (m.get(e.pendingStatusName) ?? 0) + Number(t.value));
          }
          break;
        }
        if (prev === "UnusedStatusPoint" && last === "value" && t.name === "numberValue") {
          e.unusedStatusPoints = Number(t.value);
          break;
        }
        // SaveParameter.value 下的角色欄位(玩家與帕魯共用同一批 key 名)
        if (last === "value" && typeof prev === "string") {
          if (t.name === "stringValue") {
            const v = t.value as string;
            if (prev === "NickName") e.nickName = v;
            else if (prev === "CharacterID") e.characterId = v;
            else if (prev === "OwnerPlayerUId") e.ownerUid = v;
            else if (v.startsWith("EPalGenderType::")) e.gender = v;
          } else if (t.name === "numberValue") {
            const n = Number(t.value);
            // Int/Int64Property 的數字直接在 <欄位>.value;ByteProperty(Level/Rank/Talent_*)
            // 多包一層 enum 殼:<欄位>.value = {type:"None", value:<byte>} → 數字在 .value.value,
            // 此時欄位名要往上多看一層(cheahjs archive.py ByteProperty 序列化,palsav 同構)。
            const field = prev === "value" && rel.length >= 3 ? rel[rel.length - 3] : prev;
            if (field === "Level") e.levelNum = n;
            else if (field === "Exp") e.expNum = n;
            else if (field === "Rank") e.rank = n;
            else if (field === "Talent_HP") e.talentHp = n;
            else if (field === "Talent_Shot") e.talentShot = n;
            else if (field === "Talent_Defense") e.talentDefense = n;
          } else if (t.name === "trueValue" && prev === "IsRarePal") {
            e.isLucky = true;
          }
          break;
        }
        // 詞條:PassiveSkillList.value.values[i] 的字串陣列
        if (typeof last === "number" && t.name === "stringValue" && rel.includes("PassiveSkillList")) {
          (e.passives ??= []).push(t.value as string);
        }
        break;
      }
      case "GroupSaveDataMap": {
        if (last === "group_type" && t.name === "stringValue") {
          e.groupType = t.value as string;
          break;
        }
        if (last === "guild_name" && t.name === "stringValue") {
          e.guildName = t.value as string;
          break;
        }
        if (last === "group_id" && t.name === "stringValue") {
          e.groupId = t.value as string;
          break;
        }
        if (last === "admin_player_uid" && t.name === "stringValue") {
          e.adminUid = t.value as string;
          break;
        }
        if (last === "base_camp_level" && t.name === "numberValue") {
          e.baseCampLevel = Number(t.value);
          break;
        }
        if (typeof last === "number" && rel[rel.length - 2] === "base_ids" && t.name === "stringValue") {
          (e.baseIds ??= []).push(t.value as string);
          break;
        }
        const i = rel.lastIndexOf("players");
        if (i >= 0 && typeof rel[i + 1] === "number") {
          e.roster ??= new Map();
          const idx = rel[i + 1] as number;
          const entry = e.roster.get(idx) ?? {};
          if (last === "player_uid" && t.name === "stringValue") entry.uid = t.value as string;
          else if (last === "player_name" && t.name === "stringValue") entry.name = t.value as string;
          else if (last === "last_online_real_time" && t.name === "numberValue") {
            entry.ticks = Number(t.value);
          }
          // 無關欄位也 set:roster 的元素數 = 名冊人數,欄位缺漏不影響計數
          e.roster.set(idx, entry);
        }
        break;
      }
      case "ItemContainerSaveData":
        if (rel[0] === "key" && prev === "ID" && last === "value" && t.name === "stringValue") {
          e.keyContainerId = t.value as string;
          // key 先於 value 出現:此刻就能判定是不是要收內容的玩家容器
          e.invOwner = this.opts.itemContainerOwners?.get(normGuid(e.keyContainerId));
          break;
        }
        if (prev === "SlotNum" && last === "value" && t.name === "numberValue") {
          e.slotNum = Number(t.value);
        } else if (last === "count" && t.name === "numberValue" && rel.includes("Slots")) {
          // 槽位序列化順序:slot_index → count → item.static_id(count 先到,暫存配對)
          e.pendingCount = Number(t.value);
        } else if (last === "static_id" && t.name === "stringValue") {
          const v = t.value as string;
          if (v && v !== "None") {
            e.hasItem = true;
            if (e.invOwner) (e.items ??= []).push({ itemId: v, count: e.pendingCount ?? 0 });
          }
        }
        break;
      case "MapObjectSaveData":
        if (prev === "MapObjectId" && last === "value" && t.name === "stringValue") {
          e.mapObjectId ??= t.value as string;
        }
        break;
      case "BaseCampSaveData": {
        // RawData.value:{id,name,state,transform:{translation:{x,y,z}},group_id_belong_to,…}
        // 注意排除 fast_travel_local_transform 底下的同名 translation
        if (last === "id" && t.name === "stringValue") {
          e.baseId ??= t.value as string;
        } else if (last === "name" && t.name === "stringValue") {
          e.baseName ??= t.value as string;
        } else if (last === "group_id_belong_to" && t.name === "stringValue") {
          e.groupId ??= t.value as string;
        } else if (
          prev === "translation" &&
          (last === "x" || last === "y") &&
          t.name === "numberValue" &&
          !rel.includes("fast_travel_local_transform")
        ) {
          if (last === "x") e.baseX ??= Number(t.value);
          else e.baseY ??= Number(t.value);
        } else if (last === "container_id" && t.name === "stringValue" && rel.includes("WorkerDirector")) {
          // 據點工作帕魯的角色容器(WorkerDirector 模組)
          e.workerContainerId ??= t.value as string;
        }
        break;
      }
      case "GuildExtraSaveDataMap": {
        // 元素 key = 公會 group id(Map<Guid, Struct>)
        if ((rel.length === 1 && last === "key") || (rel[0] === "key" && last === "value")) {
          if (t.name === "stringValue") e.extraGuildId ??= t.value as string;
          break;
        }
        if (last === "container_id" && t.name === "stringValue" && rel.includes("GuildItemStorage")) {
          e.storageContainerId ??= t.value as string;
          break;
        }
        if (rel.includes("Lab")) {
          if (last === "research_id" && t.name === "stringValue") {
            e.pendingResearchId = t.value as string;
          } else if (last === "work_amount" && t.name === "numberValue" && e.pendingResearchId) {
            (e.researchEntries ??= []).push({ id: e.pendingResearchId, workAmount: Number(t.value) });
            e.pendingResearchId = undefined;
          } else if (last === "current_research_id" && t.name === "stringValue") {
            e.currentResearchId = t.value as string;
          }
        }
        break;
      }
      default:
        break;
    }
  }

  /** 串流讀完後,把名冊換算成離線天數並排序。 */
  finish(levelSavMtimeMs: number): LevelJsonAnalysis {
    const mtimeTicks = levelSavMtimeMs * 10_000 + EPOCH_TICKS;
    // 存檔內世界時鐘須通過合理性檢查(與 mtime 差距一年內)才採用,否則退回 mtime
    const rt = this.realDateTimeTicks;
    const nowTicks =
      rt !== null && Math.abs(rt - mtimeTicks) <= 365 * TICKS_PER_DAY ? rt : mtimeTicks;
    const rows: SaveHealthPlayerRow[] = [];
    for (const [uid, p] of this.playersSeen) {
      let days: number | null = null;
      if (p.ticks > 0) {
        const d = (nowTicks - p.ticks) / TICKS_PER_DAY;
        if (d >= 0 && d <= MAX_PLAUSIBLE_DAYS) days = Math.floor(d);
      }
      if (days !== null && days >= INACTIVE_DAYS) {
        rows.push({ name: p.name, uid, lastOnlineDaysAgo: days, guildName: p.guildName });
      }
    }
    rows.sort((a, b) => (b.lastOnlineDaysAgo ?? 0) - (a.lastOnlineDaysAgo ?? 0));
    this.counts.playersInactive30d = rows.length;

    // 玩家快照:角色 entry(等級/經驗)+ 公會名冊(公會/最後上線)+ 名下帕魯
    const uids = new Set([...this.playerChars.keys(), ...this.playersSeen.keys()]);
    const players: SavePlayerProfile[] = [];
    for (const uid of uids) {
      const ch = this.playerChars.get(uid);
      const roster = this.playersSeen.get(uid);
      let days = daysAgoFromSav(uid, this.opts.playerSavMtimes);
      if (days === null && roster && roster.ticks > 0) {
        const d = (nowTicks - roster.ticks) / TICKS_PER_DAY;
        if (d >= 0 && d <= MAX_PLAUSIBLE_DAYS) days = Math.floor(d);
      }
      const bucket = this.palsByOwner.get(uid);
      const pals = (bucket?.rows ?? []).sort((a, b) => (b.level ?? 0) - (a.level ?? 0));

      // 公會職位與據點:名冊反查所屬公會,據點以 base_ids 對座標(缺則用 group_id 反查)
      const g = this.guilds.find((gd) => gd.memberUids.some((m) => normGuid(m) === normGuid(uid)));
      let guild: SavePlayerProfile["guild"] = null;
      if (g) {
        const byId = new Map(this.baseCamps.map((b) => [normGuid(b.id), b]));
        let bases = g.baseIds.map((id) => byId.get(normGuid(id))).filter((b): b is (typeof this.baseCamps)[number] => !!b);
        if (bases.length === 0 && g.groupId) {
          bases = this.baseCamps.filter((b) => normGuid(b.groupId) === normGuid(g.groupId));
        }
        guild = {
          name: g.name,
          role: g.adminUid && normGuid(g.adminUid) === normGuid(uid) ? "admin" : "member",
          memberCount: g.memberUids.length,
          baseCampLevel: g.baseCampLevel,
          bases: bases.map((b) => ({ id: b.id, name: b.name, x: b.x, y: b.y })),
        };
      }

      players.push({
        uid,
        name: ch?.name || roster?.name || "?",
        level: ch?.level ?? null,
        exp: ch?.exp ?? null,
        guildName: roster?.guildName ?? null,
        lastOnlineDaysAgo: days,
        palCount: bucket?.total ?? 0,
        pals,
        inventory: this.inventories.get(uid) ?? null,
        guild,
        statusPoints: ch?.statusPoints ?? [],
        unusedStatusPoints: ch?.unusedStatusPoints ?? null,
      });
    }
    players.sort((a, b) => (b.level ?? 0) - (a.level ?? 0));

    const guildNameById = new Map(this.guilds.map((g) => [normGuid(g.groupId), g.name]));
    const basePals = this.baseCamps.flatMap((base) => {
      const baseInfo = {
        id: base.id,
        name: base.name,
        guildId: base.groupId,
        guildName: guildNameById.get(normGuid(base.groupId)) ?? "?",
        x: base.x,
        y: base.y,
      };
      return (this.palsByContainer.get(normGuid(base.workerContainerId)) ?? []).map((pal) => ({
        ...pal,
        location: "base" as const,
        base: baseInfo,
      }));
    });

    // 公會完整檔案(公會頁用):成員/據點+駐守帕魯/研究;倉庫內容由呼叫端二趟掃描補
    const rosterByUid = this.playersSeen;
    const guilds: SaveGuild[] = this.guilds.map((g) => {
      const extra = this.guildExtras.get(normGuid(g.groupId));
      const byId = new Map(this.baseCamps.map((b) => [normGuid(b.id), b]));
      let camps = g.baseIds.map((id) => byId.get(normGuid(id))).filter((b): b is (typeof this.baseCamps)[number] => !!b);
      if (camps.length === 0 && g.groupId) {
        camps = this.baseCamps.filter((b) => normGuid(b.groupId) === normGuid(g.groupId));
      }
      return {
        id: g.groupId,
        name: g.name,
        adminUid: g.adminUid,
        baseCampLevel: g.baseCampLevel,
        members: g.memberUids.map((uid) => {
          const r = rosterByUid.get(uid);
          let d = daysAgoFromSav(uid, this.opts.playerSavMtimes);
          if (d === null && r && r.ticks > 0) {
            const dd = (nowTicks - r.ticks) / TICKS_PER_DAY;
            if (dd >= 0 && dd <= MAX_PLAUSIBLE_DAYS) d = Math.floor(dd);
          }
          return { uid, name: r?.name ?? "?", lastOnlineDaysAgo: d };
        }),
        bases: camps.map((b) => ({
          id: b.id,
          name: b.name,
          x: b.x,
          y: b.y,
          workers: (this.palsByContainer.get(normGuid(b.workerContainerId)) ?? []).map((pal) => ({
            characterId: pal.characterId,
            level: pal.level,
          })),
        })),
        storage: null, // 二趟掃描補(見 collectContainerContents)
        research: extra?.research ?? null,
      };
    });

    // 倉庫容器對照(guildIdNorm → containerId),給二趟掃描用
    const guildStorageContainers = new Map<string, string>();
    for (const [gid, extra] of this.guildExtras) {
      if (extra.storageContainerId) guildStorageContainers.set(gid, extra.storageContainerId);
    }

    return {
      counts: this.counts,
      inactivePlayers: rows.slice(0, MAX_INACTIVE_ROWS),
      emptyGuildNames: this.emptyGuildNames,
      players,
      guilds,
      basePals,
      guildStorageContainers,
      worldSections: [...this.worldSections].sort(),
    };
  }
}

/** 從任意 Readable(JSON 文字)分析 — 測試用這個入口餵合成資料。 */
export function analyzeLevelJsonStream(
  source: Readable,
  levelSavMtimeMs: number,
  opts: AnalyzeOptions = {},
): Promise<LevelJsonAnalysis> {
  return new Promise((resolve, reject) => {
    const analyzer = new Analyzer(opts);
    const parser = parserStream({ packValues: true, streamValues: false });
    parser.on("data", (t: Token) => analyzer.token(t));
    parser.on("end", () => resolve(analyzer.finish(levelSavMtimeMs)));
    parser.on("error", (err: Error) => reject(new Error(`存檔 JSON 解析失敗:${err.message}`)));
    source.on("error", (err: NodeJS.ErrnoException) => reject(err));
    source.pipe(parser);
  });
}

/** 二趟掃描:只收指定容器的內容(公會倉庫用)。
 *  倉庫容器 id 出現在存檔後段(GuildExtraSaveDataMap),第一趟串流經過
 *  ItemContainerSaveData 時還不知道要收誰,所以需要這一趟;除目標容器外
 *  全部跳過,成本以讀檔 IO 為主。回傳 containerId(hex)→ 內容。 */
export async function collectContainerContents(
  jsonPath: string,
  containerIds: Set<string>,
  onProgress?: (pct: number) => void,
): Promise<Map<string, SaveItemStack[]>> {
  if (containerIds.size === 0) return new Map();
  // 重用 Analyzer 的 itemContainerOwners 管線:uid 填 containerId 本身,收完取回
  const owners = new Map<string, { uid: string; kind: InventoryKind }>();
  for (const id of containerIds) owners.set(id, { uid: id, kind: "common" });

  const total = fs.statSync(jsonPath).size;
  let seen = 0;
  const stream = fs.createReadStream(jsonPath);
  if (onProgress && total > 0) {
    stream.on("data", (chunk) => {
      seen += chunk.length;
      onProgress(Math.min(99, Math.round((seen / total) * 100)));
    });
  }
  const analyzer = new Analyzer({ itemContainerOwners: owners });
  await new Promise<void>((resolve, reject) => {
    const parser = parserStream({ packValues: true, streamValues: false });
    parser.on("data", (t: Token) => analyzer.token(t));
    parser.on("end", () => resolve());
    parser.on("error", (err: Error) => reject(new Error(`存檔 JSON 解析失敗:${err.message}`)));
    stream.on("error", (err: NodeJS.ErrnoException) => reject(err));
    stream.pipe(parser);
  });
  const out = new Map<string, SaveItemStack[]>();
  for (const [id, inv] of analyzer.inventoriesView()) {
    const list = [...inv.common];
    if (inv.money > 0) list.unshift({ itemId: "Money", count: inv.money });
    out.set(id, list);
  }
  return out;
}

/** 從檔案分析,回報讀取進度(0-100)。 */
export async function analyzeLevelJsonFile(
  jsonPath: string,
  levelSavMtimeMs: number,
  onProgress?: (pct: number) => void,
  opts: AnalyzeOptions = {},
): Promise<LevelJsonAnalysis> {
  const total = fs.statSync(jsonPath).size;
  let seen = 0;
  const stream = fs.createReadStream(jsonPath);
  if (onProgress && total > 0) {
    stream.on("data", (chunk) => {
      seen += chunk.length;
      onProgress(Math.min(99, Math.round((seen / total) * 100)));
    });
  }
  return analyzeLevelJsonStream(stream, levelSavMtimeMs, opts);
}
