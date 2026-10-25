import { QuestCategory } from "./types/quest"
import type { ContentAction, ContentCatalogRow } from "./content-operations-store"

/** Calendar dates locate candidates; they never authorize new seasonal participation. */
export const MANUAL_CONTENT_TYPES = new Set([
    "gacha", "pass_card_event", "active_mission_event", "collect_item_event", "box_gacha",
    "daily_week_event", "advent_event", "story_event", "ranking_event", "challenge_dungeon_event",
    "daily_exp_mana_event", "world_story_event", "tower_dungeon_event", "expert_single_event",
    "carnival_event", "raid_event", "rush_event", "solo_time_attack_event", "hard_multi_event",
    "score_attack_event", "multi_special_exchange_campaign", "special_exchange_campaign",
    "start_dash_exchange_campaign",
])
/**
 * 内容运营开关层是否生效。
 *
 * 上游 2026-10 引入的内容运营层，语义是「没有开关记录 = 关闭新参与」——
 * 也就是下面的 defaultContentDecision / unknown*ContentDecision 在没有状态行时
 * 一律返回 false。这套机制要先把内容核验跑通、把 content_operations_state 填起来
 * 才有意义；本部署没跑过那套流程（生产库该表 0 行），结果所有 gacha / box_gacha /
 * rush_event / 商店都被判成关闭，客户端点抽卡收到 400 "Gacha is not available."
 * 直接崩回标题页。
 *
 * 在 .env 里把 WDFP_CONTENT_CONTROLS 设成 off，本文件的四个「缺记录」兜底
 * 就返回 null（「无意见」），调用方回落到素材自带的档期与资格检查，
 * 也就是合并之前的行为。默认值仍是 enforced，测试与上游语义不变。
 * 显式的状态行不受影响，开关打开后依然以运营配置为准。
 */
export function contentControlsEnforced(): boolean {
    return (process.env.WDFP_CONTENT_CONTROLS || "enforced").trim().toLowerCase() !== "off"
}
const SHOP_TYPES = new Set(["general_shop", "treasure_shop", "star_grain_shop", "boss_coin_shop", "event_item_shop"])
// Master data uses far-future sentinels for ordinary permanent products and core missions.
const PERMANENT_SENTINEL_MS = Date.UTC(2100, 0, 1)
// These native recurring dailies use 2050/2051 end dates, rather than the shared sentinel.
// Only reviewed catalog entries may retain their original dates and qualification rules.
const CORE_DAILY_MISSION_IDS = new Set([11, 13, 14, 16, 17, 10075])

export function requiresManualContentControl(row: ContentCatalogRow): boolean {
    return MANUAL_CONTENT_TYPES.has(row.type)
        || ((SHOP_TYPES.has(row.type) || row.type.startsWith("mission_"))
            && (row.parentKey !== undefined || row.personalWindow === true
                || (row.originalEndMs !== null && row.originalEndMs < PERMANENT_SENTINEL_MS)))
}

/** A missing override closes new participation, while accrued rights keep their business qualification checks. */
export function defaultContentDecision(row: ContentCatalogRow, action: ContentAction): boolean | null {
    if (!contentControlsEnforced()) return null
    if ((action === "visible" || action === "enter") && row.type === "mission_daily"
        && CORE_DAILY_MISSION_IDS.has(row.id) && row.key === `mission_daily:${row.id}`
        && row.parentKey === undefined && row.personalWindow !== true) return null
    if (!requiresManualContentControl(row)) return null
    if (action === "visible" || action === "enter") return false
    if (action === "claim" && (row.type === "pass_card_event" || row.type.startsWith("mission_")
        || row.type === "active_mission_event")) return true
    if (action === "exchange" && ["gacha", "multi_special_exchange_campaign", "special_exchange_campaign",
        "start_dash_exchange_campaign"].includes(row.type)) return true
    // Shop exchange spends currency to create a new purchase; it is a participation action.
    if (action === "exchange" && SHOP_TYPES.has(row.type)) return false
    // Closing a box mutates its remaining rewards; inspecting saved history alone grants no such action.
    if (action === "claim" && row.type === "box_gacha") return false
    return null
}

/** New master rows not yet in the reviewed catalog cannot silently use their original date window. */
export function unknownContentDecision(type: string, action: ContentAction): boolean | null {
    if (!contentControlsEnforced()) return null
    if (SHOP_TYPES.has(type) && (action === "visible" || action === "exchange")) return false
    return MANUAL_CONTENT_TYPES.has(type) ? false : null
}

/** These existing category-26 rows are permanent ordinary boss difficulties, not event instances. */
const CORE_HARD_MULTI_QUEST_IDS = new Set([
    2080001, 2081001, 2082001, 2083001, 2084001, 2085001, 2086001, 2087001, 2088001,
    2035001, 2037001, 2038001, 2039001, 2040001, 2041001, 2025001, 2026001, 2027001,
    2028001, 2029001, 2030001, 2051001, 2052001, 2053001, 2054001, 2055001, 2056001,
])
const SEASONAL_QUEST_CATEGORIES = new Set<number>([
    QuestCategory.DAILY_WEEK_EVENT, QuestCategory.ADVENT_EVENT_SINGLE, QuestCategory.ADVENT_EVENT_MULTI,
    QuestCategory.STORY_EVENT_SINGLE, QuestCategory.RANKING_EVENT_SINGLE, QuestCategory.CHALLENGE_DUNGEON_EVENT,
    QuestCategory.DAILY_EXP_MANA_EVENT, QuestCategory.WORLD_STORY_EVENT, QuestCategory.WORLD_STORY_EVENT_BOSS_BATTLE,
    QuestCategory.TOWER_DUNGEON_EVENT, QuestCategory.EXPERT_SINGLE_EVENT, QuestCategory.CARNIVAL_EVENT,
    QuestCategory.RAID_EVENT, QuestCategory.RUSH_EVENT, QuestCategory.SOLO_TIME_ATTACK_EVENT,
    QuestCategory.HARD_MULTI_EVENT, QuestCategory.SCORE_ATTACK_EVENT,
])
/** Applied only when the reviewed quest map has no entry. Core main/boss/character/practice retain their own rules. */
export function unknownQuestContentDecision(category: number, questId: number): boolean | null {
    if (!contentControlsEnforced()) return null
    if (category === QuestCategory.HARD_MULTI_EVENT && CORE_HARD_MULTI_QUEST_IDS.has(questId)) return null
    return SEASONAL_QUEST_CATEGORIES.has(category) ? false : null
}

export function unknownMissionContentDecision(category: number, enableEnd?: string): boolean | null {
    if (!contentControlsEnforced()) return null
    if ([0, 3, 4, 6, 7, 8].includes(category)) return false
    if ((category === 1 || category === 2) && enableEnd) {
        const end = Date.parse(`${enableEnd.replace(" ", "T")}+08:00`)
        if (!Number.isFinite(end) || end < PERMANENT_SENTINEL_MS) return false
    }
    return null
}
