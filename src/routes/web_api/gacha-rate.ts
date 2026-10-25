/**
 * 卡池概率覆盖 · 后台接口。
 *
 * 数据来源：
 *  - `config/gacha-rate.json` 的 `fiveStarPercent`（由 `src/lib/gacha-rate-override.ts` 热加载）
 *  - `players_gacha_info`：游戏里**真正能看到**的卡池就是这张表里有行的那些
 *    （`assets/gacha.json` 的 588 个池全部没写 `enforceAvailabilityWindow`，
 *    `isGachaAvailableAt()` 从不生效，日期字段只是资料）
 *  - `assets/cdndata/gacha.json`：客户端的卡池名，只在后台展示用
 *
 * 挂载点 `/api/server/gacha-rate`——`/api/server` 前缀已在
 * `src/lib/management-auth.ts` 的白名单里，所以不用再动鉴权文件。
 */
import type { FastifyInstance } from "fastify"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { hasManagementSession } from "../../lib/management-auth"
import { serverGachas } from "../../lib/content-master"
import { getDb } from "../../data/db"
import {
    applyFiveStarRate,
    getGachaRateOverride,
    setGachaRateOverride,
} from "../../lib/gacha-rate-override"
import { getServerDate } from "../../utils"
import type { Gacha, GachaRankRates } from "../../lib/types/gacha"

const CHARACTER_GACHA_TYPE = 0

/** assets/gacha.json 里没写 rankRates 时的兜底，与 src/lib/gacha.ts 保持一致。 */
const FALLBACK_RANK_RATES: GachaRankRates = {
    normal: [50, 250, 700],
    multiGuarantee: [50, 950],
}

/** 客户端卡池名 `assets/cdndata/gacha.json[id][0][1]`，只在后台展示，缺了不影响判定。 */
let gachaNames: Map<number, string> | null = null
function nameOf(id: number): string | null {
    if (gachaNames === null) {
        gachaNames = new Map()
        const candidates = [
            resolve(__dirname, "../../../assets/cdndata/gacha.json"),
            resolve(process.cwd(), "assets/cdndata/gacha.json"),
        ]
        for (const file of candidates) {
            try {
                const parsed = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>
                for (const [key, value] of Object.entries(parsed)) {
                    const rows = value as Array<Array<unknown>> | undefined
                    const name = rows?.[0]?.[1]
                    if (typeof name === "string" && name.trim() !== "") gachaNames.set(Number(key), name)
                }
                if (gachaNames.size > 0) break
            } catch {
                // 换下一个候选路径；两个都失败就只显示 ID。
            }
        }
    }
    return gachaNames.get(id) ?? null
}

/** 5★ 在权重数组里永远是第 0 档，返回百分比（一位小数）。 */
function fiveStarPercentOf(weights: readonly number[] | undefined): number | null {
    if (!weights || weights.length === 0) return null
    const total = weights.reduce((sum, weight) => sum + (Number.isFinite(weight) && weight > 0 ? weight : 0), 0)
    if (total <= 0) return null
    return Math.round((Math.max(0, weights[0]) / total) * 1000) / 10
}

interface PoolRow {
    id: number
    name: string | null
    type: number
    overridable: boolean
    players: number
    originalFiveStarPercent: number | null
    originalGuaranteeFiveStarPercent: number | null
    effectiveFiveStarPercent: number | null
    effectiveGuaranteeFiveStarPercent: number | null
    guaranteeFourStarPercent: number | null
    applied: boolean
    startDate: string | null
    endDate: string | null
}

/** `players_gacha_info` 里的卡池 = 游戏里能看到并能抽的卡池。 */
interface LivePools {
    /** gacha_id → 持有该池的玩家数 */
    counts: Map<number, number>
    /** 持有任一卡池的玩家总数 */
    players: number
}

function livePools(): LivePools {
    const db = getDb()
    const rows = db
        .prepare("SELECT gacha_id AS id, COUNT(*) AS holders FROM players_gacha_info GROUP BY gacha_id")
        .all() as Array<{ id: number; holders: number }>
    const players = db
        .prepare("SELECT COUNT(DISTINCT player_id) AS total FROM players_gacha_info")
        .get() as { total: number } | undefined
    return {
        counts: new Map(rows.map(row => [Number(row.id), Number(row.holders)])),
        players: Number(players?.total ?? 0),
    }
}

function buildPools(fiveStarPercent: number | null, counts: Map<number, number>): PoolRow[] {
    const pools: PoolRow[] = []
    for (const [id, players] of counts) {
        const gacha = (serverGachas as Record<string, Gacha | undefined>)[String(id)]
        // 表里有行但素材里没有这个池：客户端会拿到一个空池，值得在后台标出来。
        if (!gacha) {
            pools.push({
                id, name: nameOf(id), type: -1, overridable: false, players,
                originalFiveStarPercent: null, originalGuaranteeFiveStarPercent: null,
                effectiveFiveStarPercent: null, effectiveGuaranteeFiveStarPercent: null,
                guaranteeFourStarPercent: null, applied: false, startDate: null, endDate: null,
            })
            continue
        }
        const overridable = gacha.type === CHARACTER_GACHA_TYPE
        const percent = overridable ? fiveStarPercent : null
        const base = gacha.rankRates ?? FALLBACK_RANK_RATES
        const baseNormal = base.normal ?? []
        const baseGuarantee = base.multiGuarantee ?? []
        const weightsNormal = percent === null ? [...baseNormal] : applyFiveStarRate(baseNormal, percent)
        const weightsGuarantee = percent === null ? [...baseGuarantee] : applyFiveStarRate(baseGuarantee, percent)
        const originalNormal = fiveStarPercentOf(baseNormal)
        const effectiveNormal = fiveStarPercentOf(weightsNormal)
        const effectiveGuarantee = fiveStarPercentOf(weightsGuarantee)
        pools.push({
            id,
            name: nameOf(id),
            type: gacha.type,
            overridable,
            players,
            originalFiveStarPercent: originalNormal,
            originalGuaranteeFiveStarPercent: fiveStarPercentOf(baseGuarantee),
            effectiveFiveStarPercent: effectiveNormal,
            effectiveGuaranteeFiveStarPercent: effectiveGuarantee,
            guaranteeFourStarPercent: effectiveGuarantee === null ? null : Math.round((100 - effectiveGuarantee) * 10) / 10,
            applied: effectiveNormal !== null && originalNormal !== null && Math.abs(effectiveNormal - originalNormal) > 0.05,
            startDate: gacha.startDate ?? null,
            endDate: gacha.endDate ?? null,
        })
    }
    return pools.sort((a, b) => a.id - b.id)
}

function snapshot() {
    const fiveStarPercent = getGachaRateOverride()?.fiveStarPercent ?? null
    const live = livePools()
    const pools = buildPools(fiveStarPercent, live.counts)
    return {
        fiveStarPercent,
        enabled: fiveStarPercent !== null,
        // 只回相对路径：这是运维自己机器上的路径，没必要完整回给浏览器。
        configPath: "config/gacha-rate.json",
        serverTime: getServerDate().toISOString(),
        pools,
        totals: {
            pools: pools.length,
            players: live.players,
            overridden: pools.filter(pool => pool.applied).length,
            characterPools: pools.filter(pool => pool.overridable).length,
            missingFromAssets: pools.filter(pool => pool.type === -1).length,
        },
    }
}

export default async function routes(fastify: FastifyInstance): Promise<void> {
    // 外层 /api 守卫不一定装在所有部署上，这里自己再校验一次。
    fastify.addHook("onRequest", async (request, reply) => {
        reply.header("Cache-Control", "no-store")
        if (!hasManagementSession(request)) return reply.status(401).send({ error: "需要管理登录" })
    })

    fastify.get("/", async (_request, reply) => reply.send(snapshot()))

    fastify.post("/", { bodyLimit: 8192 }, async (request, reply) => {
        const raw = (request.body as { fiveStarPercent?: unknown } | null)?.fiveStarPercent
        if (raw === null || raw === undefined || raw === "") {
            setGachaRateOverride(null)
            return reply.send({ ok: true, fiveStarPercent: null })
        }
        const value = Number(raw)
        if (!Number.isFinite(value) || value <= 0 || value >= 100) {
            return reply.status(400).send({ error: "五星出货率需在 0 ~ 100 之间（不含两端）" })
        }
        const rounded = Math.round(value * 10) / 10
        setGachaRateOverride(rounded)
        return reply.send({ ok: true, fiveStarPercent: rounded })
    })
}
