import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { serverGachas } from "../../lib/content-master"
import { getServerDate } from "../../utils"
import {
    getGachaRowsByPlayerSync,
    getPlayerIdsSync,
    syncGachaForAllPlayersSync,
} from "../../data/domains/gacha"
import {
    GACHA_POOL_CONFIG_PATH,
    getEnabledPools,
    setEnabledPools,
} from "../../lib/gacha-pool-registry"

/**
 * 联动角色 ID。
 *
 * 为什么要硬编码：卡池数据里没有「这是联动」这个标记，只能靠角色 ID 反查。
 * 目前主数据里存在三波联动共 14 个角色，名称来自
 * assets/cdndata/character_text.json（t[id][0][0]）。
 */
const COLLAB_CHARACTER_IDS = new Set<number>([
    // 为美好的世界献上祝福
    111117, // 惠惠
    151111, // 达克妮丝
    121123, // 阿克娅
    263015, // 和真
    // Re:从零开始的异世界生活
    121021, // 爱蜜莉雅
    121027, // 雷姆
    241021, // 拉姆
    263009, // 菜月·昴
    // 佐贺偶像是传奇
    121009, // 源樱
    141009, // 二阶堂咲
    151015, // 星川莉莉
    161009, // 绉野纯子
    231014, // 水野爱
    263003, // 山田多惠
])

interface GachaStatic {
    id: number
    name: string
    type: number
    kind: "角色" | "装备" | "其它"
    startDate: string | null
    endDate: string | null
    enforced: boolean
    fiveStarCount: number
    poolSize: number
    collab: boolean
}

interface GachaPoolEntry extends GachaStatic {
    enabled: boolean
    inWindow: boolean
}

/** 主数据是静态的，构建一次即可 —— 免得每次请求都遍历 588 个池。 */
let staticCache: GachaStatic[] | null = null
let staticIndex: Map<number, GachaStatic> | null = null

function kindOf(type: number): GachaStatic["kind"] {
    if (type === 0) return "角色"
    if (type === 1) return "装备"
    return "其它"
}

/** 主数据的日期串是「中国标准时间、不带时区」，按 +08:00 解析。 */
function parseServerDate(value: string | null | undefined): number {
    if (!value) return NaN
    return Date.parse(`${String(value).trim().replace(" ", "T")}+08:00`)
}

function buildStaticCache(): GachaStatic[] {
    if (staticCache) return staticCache
    const rows: GachaStatic[] = []
    for (const [key, gacha] of Object.entries(serverGachas as Record<string, any>)) {
        const id = Number(key)
        if (!Number.isFinite(id) || !gacha) continue

        let fiveStarCount = 0
        let poolSize = 0
        let collab = false
        const pool = gacha.pool
        if (pool && typeof pool === "object") {
            for (const items of Object.values(pool)) {
                if (!Array.isArray(items)) continue
                for (const item of items) {
                    poolSize++
                    if (item?.rank === 5 || item?.rarity === 5) fiveStarCount++
                    if (COLLAB_CHARACTER_IDS.has(Number(item?.id))) collab = true
                }
            }
        }

        rows.push({
            id,
            name: typeof gacha.name === "string" && gacha.name ? gacha.name : `卡池 ${id}`,
            type: Number(gacha.type ?? -1),
            kind: kindOf(Number(gacha.type ?? -1)),
            startDate: gacha.startDate ?? null,
            endDate: gacha.endDate ?? null,
            enforced: gacha.enforceAvailabilityWindow === true,
            fiveStarCount,
            poolSize,
            collab,
        })
    }
    rows.sort((a, b) => a.id - b.id)
    staticCache = rows
    staticIndex = new Map(rows.map(row => [row.id, row]))
    return rows
}

function parseIdList(raw: unknown): number[] {
    const list = Array.isArray(raw) ? raw : []
    const seen = new Set<number>()
    for (const value of list) {
        const id = Number(value)
        if (Number.isInteger(id) && id > 0) seen.add(id)
    }
    return [...seen]
}

/** 现有玩家行里出现过的全部卡池 —— 配置文件还不存在时用它当初始答案。 */
function unionOfRows(): number[] {
    const union = new Set<number>()
    for (const ids of getGachaRowsByPlayerSync().values()) {
        for (const id of ids) union.add(id)
    }
    return [...union]
}

/** 有多少玩家的行集合和全局答案不一致。 */
function countDriftedPlayers(target: readonly number[]): number {
    const wanted = new Set(target)
    const playerIds = getPlayerIdsSync()
    const rows = getGachaRowsByPlayerSync()
    let drifted = 0
    for (const playerId of playerIds) {
        const have = rows.get(playerId) ?? []
        if (have.length !== wanted.size) { drifted++; continue }
        if (have.some(id => !wanted.has(id))) drifted++
    }
    return drifted
}

const routes = async (fastify: FastifyInstance) => {
    fastify.get("/", async (_request: FastifyRequest, reply: FastifyReply) => {
        const now = getServerDate().getTime()
        const registry = getEnabledPools(unionOfRows())
        const enabled = new Set(registry.enabled)
        const entries = buildStaticCache()

        const items: GachaPoolEntry[] = entries.map(entry => {
            const start = parseServerDate(entry.startDate)
            const end = parseServerDate(entry.endDate)
            // 时间窗只有在池子显式开了 enforceAvailabilityWindow 时才拦人，
            // 现有 588 个池全都没开，所以这里只作为参考信息展示。
            const inWindow = (!Number.isFinite(start) || now >= start)
                && (!Number.isFinite(end) || now <= end)
            return { ...entry, enabled: enabled.has(entry.id), inWindow }
        })

        return reply.send({
            serverTime: new Date(now).toISOString(),
            configPath: GACHA_POOL_CONFIG_PATH,
            persisted: registry.persisted,
            totalPlayers: getPlayerIdsSync().length,
            driftedPlayers: countDriftedPlayers(registry.enabled),
            total: items.length,
            enabledCount: items.filter(i => i.enabled).length,
            windowedCount: items.filter(i => i.inWindow).length,
            collabCount: items.filter(i => i.collab).length,
            items,
        })
    })

    fastify.post("/set", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as { gachaIds?: unknown; enabled?: unknown }
        if (typeof body?.enabled !== "boolean") {
            return reply.status(400).send({ error: "enabled 必须是布尔值" })
        }
        const gachaIds = parseIdList(body?.gachaIds)
        if (gachaIds.length === 0) {
            return reply.status(400).send({ error: "缺少有效的 gachaIds" })
        }

        buildStaticCache()
        const unknown = gachaIds.filter(id => !staticIndex?.has(id))
        if (unknown.length > 0) {
            return reply.status(400).send({ error: `卡池不存在：${unknown.slice(0, 5).join(", ")}` })
        }

        const current = new Set(getEnabledPools(unionOfRows()).enabled)
        for (const id of gachaIds) {
            if (body.enabled) current.add(id)
            else current.delete(id)
        }

        const next = setEnabledPools([...current])
        const result = syncGachaForAllPlayersSync(next)
        return reply.send({
            ok: true,
            enabledCount: next.length,
            ...result,
        })
    })

    /** 配置文件没变，只是把现有玩家重新对齐（新玩家加入后跑一次）。 */
    fastify.post("/sync", async (_request: FastifyRequest, reply: FastifyReply) => {
        const registry = getEnabledPools(unionOfRows())
        const next = setEnabledPools(registry.enabled)
        const result = syncGachaForAllPlayersSync(next)
        return reply.send({ ok: true, enabledCount: next.length, ...result })
    })
}

export default routes
