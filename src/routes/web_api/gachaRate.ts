import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { serverGachas } from "../../lib/content-master";
import { getServerDate } from "../../utils";
import {
    GACHA_RATE_CONFIG_PATH,
    applyFiveStarRate,
    getGachaRateOverride,
    setGachaRateOverride,
} from "../../lib/gacha-rate-override";
import { getGachaRowsByPlayerSync } from "../../data/domains/gacha";
import { getEnabledPools } from "../../lib/gacha-pool-registry";

/** 角色卡池的兜底概率（assets/gacha.json 里没写 rankRates 时才用）。 */
const FALLBACK_RANK_RATES = {
    normal: [50, 250, 700],
    multiGuarantee: [50, 950],
};

function percentOfFiveStar(weights: readonly number[] | undefined): number | null {
    if (!weights || weights.length === 0) return null;
    const total = weights.reduce((sum, w) => sum + (Number.isFinite(w) && w > 0 ? w : 0), 0);
    if (total <= 0) return null;
    return Math.round((weights[0] / total) * 1000) / 10;
}

interface ActiveGachaRow {
    id: number;
    name: string;
    startDate: string | null;
    endDate: string | null;
    originalNormal: number | null;
    originalGuarantee: number | null;
    effectiveNormal: number | null;
    effectiveGuarantee: number | null;
    guaranteedFourStar: number | null;
    weightsNormal: number[];
    weightsGuarantee: number[];
    /** 卡池日期窗内 / 窗外。现网没有任何池校验这个窗口，只作参考 */
    inWindow: boolean;
    /** false = 必得池或单档位池，覆盖对它不生效 */
    applied: boolean;
}

function collectActive(now: Date, fiveStarPercent: number | null, enabledIds: ReadonlySet<number>): ActiveGachaRow[] {
    const rows: ActiveGachaRow[] = [];
    for (const [key, gacha] of Object.entries(serverGachas as Record<string, any>)) {
        // type 0 = 角色卡池；装备/其它池不受这个开关影响
        if (gacha?.type !== 0) continue;
        // 真正决定「游戏里看得到」的是 players_gacha_info 的行，不是日期
        if (!enabledIds.has(Number(key))) continue;
        const start = gacha.startDate ? new Date(`${gacha.startDate}`.replace(" ", "T")) : null;
        const end = gacha.endDate ? new Date(`${gacha.endDate}`.replace(" ", "T")) : null;
        const inWindow = !((start && now < start) || (end && now > end));

        const base = gacha.rankRates ?? FALLBACK_RANK_RATES;
        const baseNormal: number[] = base.normal ?? [];
        const weightsNormal = fiveStarPercent === null
            ? [...baseNormal]
            : applyFiveStarRate(baseNormal, fiveStarPercent);
        const weightsGuarantee = fiveStarPercent === null
            ? [...(base.multiGuarantee ?? [])]
            : applyFiveStarRate(base.multiGuarantee ?? [], fiveStarPercent);

        const originalNormal = percentOfFiveStar(baseNormal);
        const effectiveNormal = percentOfFiveStar(weightsNormal);
        const effectiveGuarantee = percentOfFiveStar(weightsGuarantee);

        rows.push({
            id: Number(key),
            name: gacha.name ?? String(key),
            startDate: gacha.startDate ?? null,
            endDate: gacha.endDate ?? null,
            originalNormal,
            originalGuarantee: percentOfFiveStar(base.multiGuarantee),
            effectiveNormal,
            effectiveGuarantee,
            guaranteedFourStar: effectiveGuarantee === null ? null
                : Math.round((100 - effectiveGuarantee) * 10) / 10,
            weightsNormal,
            weightsGuarantee,
            inWindow,
            applied: effectiveNormal !== null && originalNormal !== null
                && Math.abs(effectiveNormal - originalNormal) > 0.05,
        });
    }
    return rows.sort((a, b) => a.id - b.id);
}

/** 全局启用集合 —— 和「卡池开关」页共用同一份配置。 */
function currentlyEnabledGachaIds(): Set<number> {
    const union = new Set<number>()
    for (const ids of getGachaRowsByPlayerSync().values()) {
        for (const id of ids) union.add(id)
    }
    return new Set(getEnabledPools([...union]).enabled)
}

const routes = async (fastify: FastifyInstance) => {    fastify.get("/", async (_request: FastifyRequest, reply: FastifyReply) => {
        const override = getGachaRateOverride();
        const fiveStarPercent = override?.fiveStarPercent ?? null;
        const now = getServerDate();
        return reply.send({
            fiveStarPercent,
            enabled: fiveStarPercent !== null,
            configPath: GACHA_RATE_CONFIG_PATH,
            serverTime: now.toISOString(),
            active: collectActive(now, fiveStarPercent, currentlyEnabledGachaIds()),
        });
    });

    fastify.post("/", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as { fiveStarPercent?: number | string | null };
        const raw = body?.fiveStarPercent;
        if (raw === null || raw === undefined || raw === "") {
            setGachaRateOverride(null);
            return reply.send({ ok: true, fiveStarPercent: null });
        }
        const value = Number(raw);
        if (!Number.isFinite(value) || value <= 0 || value >= 100) {
            return reply.status(400).send({ error: "五星出货率需在 0 ~ 100 之间（不含两端）" });
        }
        setGachaRateOverride(Math.round(value * 10) / 10);
        return reply.send({ ok: true, fiveStarPercent: Math.round(value * 10) / 10 });
    });
};

export default routes;
