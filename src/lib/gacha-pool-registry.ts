import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

/**
 * 全局卡池开关登记表。
 *
 * 为什么需要这个文件：客户端显示的卡池 = `players_gacha_info` 的行，而这张表是
 * 按玩家存的。想让「所有玩家统一」，就得有个独立的地方记住全局答案，
 * 否则没法回答「这个池现在到底算开着还是关着」，也没法把新玩家补上。
 */
const FILE = resolve(process.env.GACHA_POOL_CONFIG || "config/gacha-pools.json")

export const GACHA_POOL_CONFIG_PATH = FILE

interface PoolConfigFile {
    enabled: number[]
}

let cached: { mtimeMs: number; enabled: number[] } | null = null

function normalize(value: unknown): number[] {
    const list = Array.isArray(value) ? value : []
    const seen = new Set<number>()
    for (const raw of list) {
        const id = Number(raw)
        if (Number.isInteger(id) && id > 0) seen.add(id)
    }
    return [...seen].sort((a, b) => a - b)
}

export interface GachaPoolRegistry {
    enabled: number[]
    /** false = 文件还不存在，enabled 是调用方给的兜底值 */
    persisted: boolean
}

/**
 * Reads the global enabled set.
 *
 * @param fallback Used when the config file is missing (first run) — the caller
 *   passes the union of rows that already exist in the database so an existing
 *   deployment keeps whatever it had.
 */
export function getEnabledPools(fallback: readonly number[] = []): GachaPoolRegistry {
    if (!existsSync(FILE)) {
        return { enabled: normalize(fallback), persisted: false }
    }
    const mtimeMs = statSync(FILE).mtimeMs
    if (cached && cached.mtimeMs === mtimeMs) {
        return { enabled: cached.enabled, persisted: true }
    }
    try {
        const raw = JSON.parse(readFileSync(FILE, "utf8")) as Partial<PoolConfigFile>
        const enabled = normalize(raw?.enabled)
        cached = { mtimeMs, enabled }
        return { enabled, persisted: true }
    } catch {
        // 文件坏了就当成空表，不要拖垮接口
        return { enabled: [], persisted: true }
    }
}

export function setEnabledPools(enabled: readonly number[]): number[] {
    const normalized = normalize(enabled)
    const dir = dirname(FILE)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(FILE, `${JSON.stringify({ enabled: normalized }, null, 2)}\n`, "utf8")
    cached = { mtimeMs: statSync(FILE).mtimeMs, enabled: normalized }
    return normalized
}
