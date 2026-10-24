import { useEffect, useState } from "react"
import {
    Alert, Button, Card, Col, InputNumber, Row, Slider, Space, Statistic, Table, Tag, Typography, message,
} from "antd"
import { ReloadOutlined, UndoOutlined, SaveOutlined } from "@ant-design/icons"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { apiGet, apiPost } from "../api/client"
import { AdminPage, StateCard } from "../components/AdminPage"

const { Text } = Typography

interface ActiveGacha {
    id: number
    name: string
    startDate: string | null
    endDate: string | null
    originalNormal: number | null
    originalGuarantee: number | null
    effectiveNormal: number | null
    effectiveGuarantee: number | null
    guaranteedFourStar: number | null
    applied: boolean
}

interface GachaRateResp {
    fiveStarPercent: number | null
    enabled: boolean
    configPath: string
    serverTime: string
    active: ActiveGacha[]
}

const PRESETS = [7.5, 10, 15, 20, 30, 50]

export default function GachaRate() {
    const qc = useQueryClient()
    const [value, setValue] = useState<number>(20)

    const { data, isLoading, isError, refetch, isFetching } = useQuery({
        queryKey: ["gacha-rate"],
        queryFn: () => apiGet<GachaRateResp>("/api/gacha-rate"),
    })

    useEffect(() => {
        if (data) setValue(data.fiveStarPercent ?? data.active[0]?.originalNormal ?? 7.5)
    }, [data])

    const invalidate = () => qc.invalidateQueries({ queryKey: ["gacha-rate"] })

    const save = useMutation({
        mutationFn: (v: number) => apiPost("/api/gacha-rate", { fiveStarPercent: v }),
        onSuccess: () => { message.success("已保存，立即生效"); invalidate() },
        onError: (e: Error) => message.error(e.message),
    })
    const reset = useMutation({
        mutationFn: () => apiPost("/api/gacha-rate", { fiveStarPercent: null }),
        onSuccess: () => { message.success("已恢复游戏原始概率"); invalidate() },
        onError: (e: Error) => message.error(e.message),
    })

    if (isLoading) return <StateCard><Text type="secondary">加载中…</Text></StateCard>
    if (isError || !data) return <Card><Text type="danger">接口不可用</Text></Card>

    const columns = [
        {
            title: "卡池", key: "name", ellipsis: true,
            render: (_: unknown, r: ActiveGacha) => (
                <Space size={6}>
                    <span>{r.name}</span>
                    {!r.applied && <Tag color="default">必得 · 不生效</Tag>}
                </Space>
            ),
        },
        {
            title: "原版 5★", key: "orig", width: 110, align: "right" as const,
            render: (_: unknown, r: ActiveGacha) => <Text type="secondary">{r.originalNormal ?? "—"}%</Text>,
        },
        {
            title: "当前 5★", key: "eff", width: 110, align: "right" as const,
            render: (_: unknown, r: ActiveGacha) => (
                <Text strong style={{ color: "#3fb950" }}>{r.effectiveNormal ?? "—"}%</Text>
            ),
        },
        {
            title: "保底 5★", key: "effg", width: 110, align: "right" as const,
            render: (_: unknown, r: ActiveGacha) => <Text>{r.effectiveGuarantee ?? "—"}%</Text>,
        },
        {
            title: "保底 4★", key: "four", width: 110, align: "right" as const,
            render: (_: unknown, r: ActiveGacha) => <Text>{r.guaranteedFourStar ?? "—"}%</Text>,
        },
    ]

    return (
        <AdminPage
            eyebrow="GACHA RATE"
            title="卡池概率"
            description="调整角色卡池的五星出货率。改动写入配置文件后立即生效，不需要重启服务，也不动 assets/gacha.json 原始数据。"
            actions={<Button icon={<ReloadOutlined />} loading={isFetching} onClick={() => refetch()}>刷新</Button>}
        >
            <Space direction="vertical" size="large" style={{ width: "100%" }}>
                <Card
                    title="五星出货率"
                    size="small"
                    extra={data.enabled
                        ? <Tag color="green">已覆盖 · {data.fiveStarPercent}%</Tag>
                        : <Tag>未覆盖 · 使用游戏原始概率</Tag>}
                >
                    <Row gutter={[16, 12]} align="middle">
                        <Col xs={24} md={12}>
                            <Space align="center" size="middle" wrap>
                                <InputNumber
                                    min={0.5}
                                    max={99.5}
                                    step={0.5}
                                    value={value}
                                    onChange={v => setValue(typeof v === "number" ? v : 0)}
                                    addonAfter="%"
                                    style={{ width: 130 }}
                                />
                                <Button
                                    type="primary"
                                    icon={<SaveOutlined />}
                                    loading={save.isPending}
                                    onClick={() => save.mutate(value)}
                                >
                                    保存
                                </Button>
                                <Button
                                    icon={<UndoOutlined />}
                                    loading={reset.isPending}
                                    onClick={() => reset.mutate()}
                                >
                                    恢复原版
                                </Button>
                            </Space>
                        </Col>
                        <Col xs={24} md={12}>
                            <Space wrap size="small">
                                <Text type="secondary" style={{ fontSize: 12 }}>快捷：</Text>
                                {PRESETS.map(p => (
                                    <Button key={p} size="small" onClick={() => setValue(p)}>{p}%</Button>
                                ))}
                            </Space>
                        </Col>
                    </Row>

                    <div style={{ padding: "16px 20px 0 10px", marginTop: 8 }}>
                        <Slider
                            min={0.5}
                            max={100}
                            step={0.5}
                            value={value}
                            onChange={v => setValue(v)}
                            marks={{ 5: "5%", 20: "20%", 50: "50%", 100: "100%" }}
                        />
                    </div>

                    <Alert
                        style={{ marginTop: 16 }}
                        type="info"
                        showIcon
                        message="四星 / 三星会自动按原始比例瓜分剩下的百分比"
                        description={
                            <span>
                                例如原版 [5★ 7.5% / 4★ 25% / 3★ 67.5%]，把五星改成 20% 后变成
                                <b> 20% / 21.6% / 58.4%</b>。第 10 抽保底档只有 5★ 和 4★ 两档，同样按比例分配。
                            </span>
                        }
                    />
                </Card>

                <Card title="当前开放的卡池" size="small"
                    extra={<Text type="secondary" style={{ fontSize: 12 }}>服务器时间 {data.serverTime.slice(0, 19).replace("T", " ")}</Text>}>
                    {data.active.length === 0
                        ? <Text type="secondary">当前时间没有开放中的角色卡池</Text>
                        : (
                            <>
                                <Row gutter={24} style={{ marginBottom: 12 }}>
                                    <Col><Statistic title="开放卡池" value={data.active.length} /></Col>
                                    <Col>
                                        <Statistic
                                            title="覆盖生效"
                                            value={data.active.filter(a => a.applied).length}
                                            suffix={`/ ${data.active.length}`}
                                            valueStyle={{ color: "#3fb950" }}
                                        />
                                    </Col>
                                    <Col>
                                        <Statistic
                                            title="设定五星率"
                                            value={data.enabled ? data.fiveStarPercent ?? 0 : "原版"}
                                            suffix={data.enabled ? "%" : undefined}
                                        />
                                    </Col>
                                </Row>
                                <Table
                                    size="small"
                                    rowKey="id"
                                    scroll={{ x: "max-content" }}
                                    pagination={{ pageSize: 8, hideOnSinglePage: true, size: "small" }}
                                    dataSource={[...data.active].sort((a, b) => Number(b.applied) - Number(a.applied))}
                                    columns={columns}
                                />
                            </>
                        )}
                </Card>

                <Card title="作用范围" size="small">
                    <ul style={{ margin: 0, paddingLeft: 20, lineHeight: 1.9 }}>
                        <li><b>只影响角色卡池</b>（type=0）。装备池、box 扭蛋、星星扭蛋不受影响。</li>
                        <li><b>只升不降</b>：「★5 必得扭蛋」这类原本就是 100% 的池子保持原样，不会被拉低。</li>
                        <li>修改的是服务端抽卡时的稀有度权重，<b>和种子管理无关</b> —— 种子只负责让动画演出已经抽到的结果。</li>
                        <li>配置文件：<Text code>{data.configPath}</Text>，想手动改也可以，改完即生效。</li>
                        <li>想彻底回原版就点「恢复原版」，等价于把配置写成 <Text code>{'{ "fiveStarPercent": null }'}</Text>。</li>
                    </ul>
                </Card>
            </Space>
        </AdminPage>
    )
}
