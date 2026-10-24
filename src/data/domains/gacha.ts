import { getDb } from "../db";
import { PlayerGachaInfo, PlayerGachaCampaign, RawPlayerGachaInfo, RawPlayerGachaCampaign } from "../types";
import { deserializeBoolean, serializeBoolean, deserializeNumberList } from "../utils";
import { runPersistenceTransactionSync } from "../../lib/persistence-coordinator";
import { cachedStatement } from "../../lib/cached-statement";

/**
 * Converts a RawPlayerGachaInfo object into a PlayerGachaInfo object.
 * 
 * @param rawInfo The raw object to convert.
 * @returns The converted object.
 */
function buildPlayerGachaInfo(
    rawInfo: RawPlayerGachaInfo
): PlayerGachaInfo {
    return {
        gachaId: rawInfo.gacha_id,
        isDailyFirst: deserializeBoolean(rawInfo.is_daily_first),
        isAccountFirst: deserializeBoolean(rawInfo.is_account_first),
        gachaExchangePoint: rawInfo.gacha_exchange_point
    }
}

/**
 * Retrieves the status of various gacha banners for the player.
 * 
 * @param playerId The ID of the player.
 * @returns A list of PlayerGachaInfo.
 */
export function getPlayerGachaInfoListSync(
    playerId: number
): PlayerGachaInfo[] {
    const rawInfo = cachedStatement(getDb(), `
    SELECT gacha_id, is_daily_first, is_account_first, gacha_exchange_point
    FROM players_gacha_info
    WHERE player_id = ?
    `).all(playerId) as RawPlayerGachaInfo[]

    return rawInfo.map(raw => {
        return buildPlayerGachaInfo(raw)
    })
}

/**
 * Gets an individual gacha info for a player.
 * 
 * @param playerId The ID of the player.
 * @param gachaId The ID of the gacha.
 * @returns The info that corresponds to the provided gachaId, or null.
 */
export function getPlayerGachaInfoSync(
    playerId: number,
    gachaId: number
): PlayerGachaInfo | null {
    const rawInfo = getDb().prepare(`
    SELECT gacha_id, is_daily_first, is_account_first, gacha_exchange_point
    FROM players_gacha_info
    WHERE player_id = ? AND gacha_id = ?
    `).get(playerId, gachaId) as RawPlayerGachaInfo

    return rawInfo === undefined ? null : buildPlayerGachaInfo(rawInfo)
}

/**
 * Inserts a singular gacha info into the database for a player.
 * 
 * @param playerId The ID of the player.
 * @param gachaInfo The PlayerGachaInfo data.
 */
export function insertPlayerGachaInfoSync(
    playerId: number,
    gachaInfo: PlayerGachaInfo
) {
    getDb().prepare(`
    INSERT INTO players_gacha_info (gacha_id, is_daily_first, is_account_first, gacha_exchange_point, player_id)
    VALUES (?, ?, ?, ?, ?)
    `).run(
        gachaInfo.gachaId,
        serializeBoolean(gachaInfo.isDailyFirst),
        serializeBoolean(gachaInfo.isAccountFirst),
        gachaInfo.gachaExchangePoint == undefined ? null : gachaInfo.gachaExchangePoint,
        playerId
    )
}

/**
 * Batch inserts a list of gacha info into the database.
 * 
 * @param playerId The player's ID.
 * @param gachaInfoList The list of of PlayerGachaInfo data.
 */
export function insertPlayerGachaInfoListSync(
    playerId: number,
    gachaInfoList: PlayerGachaInfo[]
) {
    runPersistenceTransactionSync({ domain: "gacha", playerId, operation: "insert_player_gacha_info_list" }, () => {
        for (const gachaInfo of gachaInfoList) {
            insertPlayerGachaInfoSync(playerId, gachaInfo)
        }
    })
}

export interface GachaSyncResult {
    players: number
    added: number
    removed: number
}

/** 所有玩家各自的卡池行，用于算全局差异。 */
export function getGachaRowsByPlayerSync(): Map<number, number[]> {
    const rows = getDb().prepare(`
    SELECT player_id, gacha_id FROM players_gacha_info
    `).all() as { player_id: number, gacha_id: number }[]

    const map = new Map<number, number[]>()
    for (const row of rows) {
        const list = map.get(row.player_id)
        if (list === undefined) map.set(row.player_id, [row.gacha_id])
        else list.push(row.gacha_id)
    }
    return map
}

export function getPlayerIdsSync(): number[] {
    return (getDb().prepare(`SELECT id FROM players ORDER BY id`).all() as { id: number }[])
        .map(row => row.id)
}

/**
 * Makes every player's gacha list exactly match the given set.
 *
 * 游戏里能看到的卡池 = `players_gacha_info` 的行，所以「统一管理」就是让所有玩家
 * 的行集合完全一致：缺的补上，多的删掉。新玩家创建后跑一次这个函数即可对齐。
 *
 * 注意：删行会一并丢掉该池已积累的 `gacha_exchange_point`。
 *
 * @param enabledIds The gacha IDs every player should have.
 */
export function syncGachaForAllPlayersSync(
    enabledIds: readonly number[]
): GachaSyncResult {
    const target = new Set(enabledIds.filter(id => Number.isInteger(id) && id > 0))
    const playerIds = getPlayerIdsSync()
    if (playerIds.length === 0) return { players: 0, added: 0, removed: 0 }

    return runPersistenceTransactionSync(
        { domain: "gacha", operation: "sync_gacha_pools" },
        () => {
            const existing = getGachaRowsByPlayerSync()
            const insert = getDb().prepare(`
            INSERT OR IGNORE INTO players_gacha_info (gacha_id, is_daily_first, is_account_first, gacha_exchange_point, player_id)
            VALUES (?, 1, 1, 0, ?)
            `)
            const remove = getDb().prepare(`
            DELETE FROM players_gacha_info
            WHERE player_id = ? AND gacha_id = ?
            `)

            let added = 0
            let removed = 0
            for (const playerId of playerIds) {
                const have = new Set(existing.get(playerId) ?? [])
                for (const gachaId of target) {
                    if (!have.has(gachaId)) added += insert.run(gachaId, playerId).changes
                }
                for (const gachaId of have) {
                    if (!target.has(gachaId)) removed += remove.run(playerId, gachaId).changes
                }
            }
            return { players: playerIds.length, added, removed }
        }
    )
}

/**
 * Updates a player's gacha info.
 * 
 * @param playerId The ID of the player.
 * @param gachaInfo The partial PlayerGachaInfo object containing data to update.
 */
export function updatePlayerGachaInfoSync(
    playerId: number,
    gachaInfo: Partial<PlayerGachaInfo>
) {
    const id = gachaInfo.gachaId

    const fieldMap: Record<string, string> = {
        'isDailyFirst': 'is_daily_first',
        'isAccountFirst': 'is_account_first',
        'gachaExchangePoint': 'gacha_exchange_point'
    }

    const sets: string[] = []
    const values: any[] = []
    for (const key in gachaInfo) {
        const value = gachaInfo[key as keyof PlayerGachaInfo]
        const mapped = fieldMap[key]
        if (mapped && value !== undefined) {
            sets.push(`${mapped} = ?`)
            if (typeof (value) === "boolean") {
                values.push(serializeBoolean(value))
            } else {
                values.push(value)
            }
        }
    }

    if (sets.length > 0) getDb().prepare(`
        UPDATE players_gacha_info
        SET ${sets.join(', ')}
        WHERE gacha_id = ? AND player_id = ?
        `).run([...values, id, playerId]);
}

/**
 * Converts a RawPlayerGachaCampaign into a PlayerGachaCampaign.
 * 
 * @param raw The RawPlayerGachaCampaign to convert.
 * @returns The converted PlayerGachaCampaign.
 */
function buildPlayerGachaCampaign(
    raw: RawPlayerGachaCampaign
): PlayerGachaCampaign {
    return {
        gachaId: raw.gacha_id,
        campaignId: raw.campaign_id,
        count: raw.count
    }
}

/**
 * Gets the status of an individual gacha campaign.
 * 
 * @param playerId The ID of the player.
 * @param gachaId The ID of the gacha.
 * @param campaignId The ID of the gacha campaign.
 * @returns A PlayerGachaCampaign object or null.
 */
export function getPlayerGachaCampaignSync(
    playerId: number,
    gachaId: number,
    campaignId: number,
): PlayerGachaCampaign | null {
    const raw = getDb().prepare(`
    SELECT gacha_id, campaign_id, count
    FROM players_gacha_campaigns
    WHERE player_id = ? AND gacha_id = ? AND campaign_id = ?
    `).get(playerId, gachaId, campaignId) as RawPlayerGachaCampaign | undefined

    return raw === undefined ? null : buildPlayerGachaCampaign(raw)
}

/**
 * Batch gets a list of player gacha campaigns.
 * 
 * @param playerId The ID of the player.
 * @returns The list of gacha campaigns.
 */
export function getPlayerGachaCampaignListSync(
    playerId: number
): PlayerGachaCampaign[] {
    const rawList = cachedStatement(getDb(), `
    SELECT gacha_id, campaign_id, count
    FROM players_gacha_campaigns
    WHERE player_id = ?
    `).all(playerId) as RawPlayerGachaCampaign[]

    return rawList.map(raw => buildPlayerGachaCampaign(raw))
}

/**
 * Inserts a gacha campaign into a player's data.
 * 
 * @param playerId The ID of the player.
 * @param campaign The campaign to insert.
 */
export function insertPlayerGachaCampaignSync(
    playerId: number,
    campaign: PlayerGachaCampaign
) {
    getDb().prepare(`
    INSERT INTO players_gacha_campaigns (gacha_id, campaign_id, count, player_id)
    VALUES (?, ?, ?, ?)
    `).run(
        campaign.gachaId,
        campaign.campaignId,
        campaign.count,
        playerId
    )
}

export function insertPlayerGachaCampaignListSync(
    playerId: number,
    campaigns: PlayerGachaCampaign[]
) {
    runPersistenceTransactionSync({ domain: "gacha", playerId, operation: "insert_player_gacha_campaign_list" }, () => {
        for (const campaign of campaigns) {
            insertPlayerGachaCampaignSync(playerId, campaign)
        }
    })
}

/**
 * Updates a player's gacha campaign.
 * 
 * @param playerId The ID of the player.
 * @param gachaId The ID of the gacha.
 * @param campaignId The ID of the gacha campaign.
 * @param newCount The new count the gacha campaign should have.
 */
export function updatePlayerGachaCampaignSync(
    playerId: number,
    gachaId: number,
    campaignId: number,
    newCount: number
) {
    getDb().prepare(`
    UPDATE players_gacha_campaigns
    SET count = ?
    WHERE player_id = ? AND gacha_id = ? AND campaign_id = ?
    `).run(
        newCount,
        playerId,
        gachaId,
        campaignId
    )
}
/**
/**
/**
/**
 * Retrieves the missions that a player is currently completing.
 * 
 * @param playerId The ID of the player.
 * @returns A record of each mission and its current progress.
 */
