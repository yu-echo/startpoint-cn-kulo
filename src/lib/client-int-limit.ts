/**
 * 客户端整型上限。
 *
 * 客户端是 Flash/AIR：响应里的整型字段一旦 ≥ 2^31，`fixUint32Tags` 只能退化成
 * float64（0xcb）编码，而客户端这些字段是强类型 Int，解码直接抛
 * C8700「data.user_info.xxx」，整包响应作废、进不去游戏。
 *
 * 业务层可以算得更大，但写库前必须压到安全区。1 亿足够日常游玩，
 * 也留出 20 倍余量给后续累加，不会再被一次 +N 奖励顶出 int32。
 */
export const CLIENT_INT_MAX = 100_000_000

/** 把任意数值压进 [0, CLIENT_INT_MAX]，非有限数按 0 处理。 */
export function clampClientInt(value: number): number {
    if (!Number.isFinite(value)) return 0
    return Math.min(CLIENT_INT_MAX, Math.max(0, Math.trunc(value)))
}

