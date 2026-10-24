/**
 * 抽卡稀有度概率覆盖。
 *
 * 卡池的原始概率来自 `assets/gacha.json` 每个池子的 `rankRates`（如流星节
 * 是 normal:[75,250,675] → 5★ 7.5%）。改那份数据等于改游戏原始档案，
 * 587 个池子都要动，还容易被后续更新覆盖。
 *
 * 这里改成旁路覆盖：`config/gacha-rate.json` 里只写一个 `fiveStarPercent`，
 * 对所有角色卡池生效，4★/3★ 按原始比例瓜分剩下的百分比。
 * 文件按 mtime 热加载，改完不用重启。
 *
 * 内容示例：
 *   { "fiveStarPercent": 20 }   → 所有角色卡池 5★ = 20%
 *   { "fiveStarPercent": null } → 关闭覆盖，用游戏原始概率
 */
import * as fs from "node:fs"
import { resolve } from "node:path"

export interface GachaRateOverride {
    /** 5★ 出货率（百分比，0-100）。null / 缺省 = 不覆盖。 */
    fiveStarPercent: number | null
}

const FILE = resolve(process.env.GACHA_RATE_CONFIG || "config/gacha-rate.json")

/** 配置文件绝对路径，后台界面展示用。 */
export const GACHA_RATE_CONFIG_PATH = FILE

let cache: { mtimeMs: number; value: GachaRateOverride | null } | null = null

/**
 * 写入覆盖值。`null` = 关闭覆盖（回游戏原始概率）。
 * 写完立刻失效缓存，无需重启。
 */
export function setGachaRateOverride(fiveStarPercent: number | null): void {
    const dir = resolve(FILE, "..")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(FILE, JSON.stringify({ fiveStarPercent }, null, 2) + "\n", "utf-8")
    cache = null
}

export function getGachaRateOverride(): GachaRateOverride | null {
    let stat: fs.Stats
    try {
        stat = fs.statSync(FILE)
    } catch {
        cache = null
        return null
    }
    if (cache && cache.mtimeMs === stat.mtimeMs) return cache.value

    let value: GachaRateOverride | null = null
    try {
        const parsed = JSON.parse(fs.readFileSync(FILE, "utf-8")) as GachaRateOverride
        const p = parsed?.fiveStarPercent
        if (typeof p === "number" && Number.isFinite(p) && p > 0 && p < 100) {
            value = { fiveStarPercent: p }
        } else {
            value = null
        }
    } catch {
        value = null
    }
    cache = { mtimeMs: stat.mtimeMs, value }
    return value
}

/**
 * 把 5★ 概率覆盖到一组权重上。
 *
 * 权重本身只是相对值（`randomWeightedIndex` 只看总和），因此统一换算成
 * 千分比：5★ = 目标百分比 * 10，其余按原比例分。
 *
 * 两条硬规则：
 *  1. **只升不降** —— `★5必得扭蛋` 这类 original 已经是 100% 的池子保持 100%，
 *     绝不能被 20% 这种设定拉低。
 *  2. **只有一个档位的池子不动** —— 权重数组长度为 1 表示该池只有一种稀有度，
 *     强行插一档出来会造出不存在的 4★。
 */
export function applyFiveStarRate(weights: readonly number[], fiveStarPercent: number | null): number[] {
    if (fiveStarPercent === null || weights.length <= 1) return [...weights]

    const total = weights.reduce((sum, w) => sum + (Number.isFinite(w) && w > 0 ? w : 0), 0)
    if (total <= 0) return [...weights]

    const originalPercent = (Math.max(0, weights[0]) / total) * 100
    const targetPercent = Math.max(originalPercent, fiveStarPercent)
    // 已经是必得池（或接近必得），保持原样
    if (targetPercent >= 99.9) return [...weights]

    const five = Math.round(targetPercent * 10)
    const rest = 1000 - five
    const restTotal = weights.slice(1).reduce((sum, w) => sum + (Number.isFinite(w) && w > 0 ? w : 0), 0)
    if (restTotal <= 0) return [...weights]

    return [
        five,
        ...weights.slice(1).map(w => {
            const share = (Number.isFinite(w) && w > 0 ? w : 0) / restTotal
            return Math.round(rest * share)
        }),
    ]
}
