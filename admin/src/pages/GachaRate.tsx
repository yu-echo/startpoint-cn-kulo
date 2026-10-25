import { useEffect, useMemo, useState } from "react"
import { Alert, Button, Card, Col, InputNumber, Row, Slider, Space, Statistic, Table, Tag, Typography } from "antd"
import { ReloadOutlined } from "@ant-design/icons"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { apiGet, apiPost } from "../api/client"
import { AdminPage } from "../components/AdminPage"
import { useAdminEditGuard } from "../lib/editGuard"
import "./GachaRate.css"

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

interface Overview {
    fiveStarPercent: number | null
    enabled: boolean
    configPath: string
    serverTime: string
    pools: PoolRow[]
    totals: { pools: number; players: number; overridden: number; characterPools: number; missingFromAssets: number }
}

const endpoint = "/api/server/gacha-rate/"
const queryKey = ["server", "gacha-rate"]
const quickValues = [7.5, 10, 15, 20, 30, 50, 80]
const typeLabel: Record<number, string> = { 0: "角色", 1: "装备" }

const percent = (value: number | null) => value === null ? "—" : `${value}%`

export default function GachaRate() {
    const client = useQueryClient()
    const [draft, setDraft] = useState<number | null>(null)
    const [error, setError] = useState("")
    const [saved, setSaved] = useState("")

    const query = useQuery({ queryKey, queryFn: () => apiGet<Overview>(endpoint), refetchOnWindowFocus: false })
    const current = query.data?.fiveStarPercent ?? null

    // 首次拿到数据、以及保存成功后，把草稿对齐到服务器当前值。
    useEffect(() => {
        if (query.data && !query.isFetching) setDraft(query.data.fiveStarPercent)
    }, [query.data, query.isFetching])

    const dirty = query.data !== undefined && draft !== current
    useAdminEditGuard({ dirty, pending: false, label: "卡池概率" })

    const save = useMutation({
        mutationFn: (value: number | null) => apiPost<{ ok: boolean; fiveStarPercent: number | null }>(endpoint, { fiveStarPercent: value }),
        onMutate: () => { setError(""); setSaved("") },
        onSuccess: result => {
            setSaved(result.fiveStarPercent === null
                ? "已恢复游戏原始概率。"
                : `已设为 ${result.fiveStarPercent}%，下一次抽卡立即生效（无需重启）。`)
            void client.invalidateQueries({ queryKey })
        },
        onError: (failure: Error) => setError(failure.message),
    })

    const pools = query.data?.pools ?? []
    const columns = useMemo(() => [
        { title: "卡池", dataIndex: "id", width: 90, render: (id: number) => <Typography.Text code>{id}</Typography.Text> },
        {
            title: "名称", dataIndex: "name", width: 220,
            render: (name: string | null, row: PoolRow) => name
                ? <span>{name}</span>
                : <Typography.Text type="secondary">{row.type === -1 ? "素材缺失" : "（客户端未收录名称）"}</Typography.Text>,
        },
        {
            title: "类型", dataIndex: "type", width: 90,
            render: (type: number) => type === -1
                ? <Tag color="red">未知</Tag>
                : <Tag color={type === 0 ? "blue" : "default"}>{typeLabel[type] ?? `type ${type}`}</Tag>,
        },
        { title: "持有玩家", dataIndex: "players", width: 100 },
        { title: "原版 5★", dataIndex: "originalFiveStarPercent", width: 110, render: percent },
        {
            title: "实际 5★", dataIndex: "effectiveFiveStarPercent", width: 110,
            render: (value: number | null) => value === null
                ? "—"
                : <Typography.Text strong className="gacha-rate-effective">{value}%</Typography.Text>,
        },
        { title: "保底 5★", dataIndex: "effectiveGuaranteeFiveStarPercent", width: 110, render: percent },
        { title: "保底 4★", dataIndex: "guaranteeFourStarPercent", width: 110, render: percent },
        {
            title: "状态", dataIndex: "applied", width: 110,
            render: (applied: boolean, row: PoolRow) => {
                if (row.type === -1) return <Tag color="red">需要修复</Tag>
                if (!row.overridable) return <Tag>不适用</Tag>
                return applied ? <Tag color="orange">已抬高</Tag> : <Tag color="green">原版</Tag>
            },
        },
    ], [])

    return (
        <AdminPage
            eyebrow="日常运营"
            title="卡池概率"
            description={<>
                只改 5★ 出货率，4★ / 3★ 按原始比例瓜分剩下的百分点。配置写在
                <Typography.Text code>{query.data?.configPath ?? "config/gacha-rate.json"}</Typography.Text>
                ，按文件修改时间热加载，<strong>保存后下一次抽卡就生效，不用重启服务端</strong>。
            </>}
            actions={<Button icon={<ReloadOutlined />} onClick={() => void query.refetch()} loading={query.isFetching}>刷新</Button>}
        >
            {query.isError && <Alert type="error" showIcon message="读取卡池数据失败" description={(query.error as Error).message}
                action={<Button size="small" onClick={() => void query.refetch()}>重试</Button>} style={{ marginBottom: 16 }} />}

            <Row gutter={[16, 16]}>
                <Col xs={24} lg={9}>
                    <Card title="5★ 出货率" size="small">
                        <Space direction="vertical" size={16} style={{ width: "100%" }}>
                            <div className="gacha-rate-control">
                                <InputNumber
                                    aria-label="5★ 出货率百分比"
                                    min={0.1} max={99.9} step={0.5} precision={1} addonAfter="%"
                                    value={draft ?? undefined}
                                    disabled={query.isLoading || save.isPending}
                                    onChange={value => setDraft(typeof value === "number" ? value : null)}
                                    style={{ width: 160 }}
                                />
                                <Typography.Text type="secondary">
                                    {current === null ? "当前使用游戏原始概率" : `当前设定 ${current}%`}
                                </Typography.Text>
                            </div>
                            <Slider
                                min={0.1} max={99.9} step={0.1} marks={{ 7.5: "7.5", 20: "20", 50: "50", 99: "99" }}
                                value={draft ?? 7.5} disabled={query.isLoading || save.isPending}
                                onChange={value => setDraft(value)}
                            />
                            <Space wrap size={[8, 8]}>
                                {quickValues.map(value => (
                                    <Button key={value} size="small" onClick={() => setDraft(value)}
                                        type={draft === value ? "primary" : "default"}>{value}%</Button>
                                ))}
                            </Space>
                            <Space wrap>
                                <Button type="primary" disabled={!dirty} loading={save.isPending}
                                    onClick={() => save.mutate(draft)}>保存设定</Button>
                                <Button danger disabled={save.isPending || current === null}
                                    onClick={() => save.mutate(null)}>恢复原始概率</Button>
                            </Space>
                            {dirty && <Alert type="warning" showIcon message="有未保存的改动" />}
                            {saved && <Alert type="success" showIcon message={saved} />}
                            {error && <Alert type="error" showIcon message="保存失败" description={error} />}
                        </Space>
                    </Card>
                </Col>
                <Col xs={24} lg={15}>
                    <Card size="small" title="当前概况">
                        <Row gutter={[16, 16]}>
                            <Col span={8}><Statistic title="在册卡池" value={query.data?.totals.pools ?? 0} suffix="个" /></Col>
                            <Col span={8}><Statistic title="持有卡池的玩家" value={query.data?.totals.players ?? 0} suffix="人" /></Col>
                            <Col span={8}><Statistic title="实际被抬高的池" value={query.data?.totals.overridden ?? 0} suffix="个" /></Col>
                        </Row>
                        <Alert
                            type="info" showIcon style={{ marginTop: 16 }}
                            message="三条不会越界的行为"
                            description={<ul className="gacha-rate-rules">
                                <li><strong>只升不降</strong>：原版概率本来就比你设的高（例如 100% 的必得池），保持原版。</li>
                                <li><strong>单档位池不动</strong>：池子里只有一种稀有度时不会凭空造出 4★。</li>
                                <li><strong>装备池不受影响</strong>：只作用于角色卡池。</li>
                            </ul>}
                        />
                    </Card>
                </Col>
            </Row>

            <Card size="small" title={`游戏里可抽的卡池（${pools.length}）`} style={{ marginTop: 16 }}>
                <Typography.Paragraph type="secondary" className="gacha-rate-note">
                    列表来自 <Typography.Text code>players_gacha_info</Typography.Text>——这张表里有行的卡池才会出现在游戏里。
                    素材里 588 个池都没写 <Typography.Text code>enforceAvailabilityWindow</Typography.Text>，
                    日期字段只是资料，不决定开关。
                </Typography.Paragraph>
                <Table<PoolRow>
                    rowKey="id" size="small" dataSource={pools} columns={columns}
                    loading={query.isLoading} pagination={pools.length > 20 ? { pageSize: 20 } : false}
                    scroll={{ x: 1080 }}
                />
            </Card>
        </AdminPage>
    )
}
