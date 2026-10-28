/**
 * 数据看板 smoke（任务书 v1.0 §9：AC-M1~M9 / AC-M11 / AC-M13 / AC-R1 / AC-R2）。
 *
 * 用法：npm run smoke:analytics ——默认自起隔离环境（临时 SQLite + 内存队列 + mock 新闻）
 * 可选环境变量：BASE / SMOKE_BASE 指向已启动的服务（smoke:all 编排传入），设置后不再自起隔离环境。
 *
 * 造数策略：上游事实（platform_account / publish_log / copy / topic / publish_plan / benchmark_*）
 * 直接写隔离库——它们不是本模块的职责，走 HTTP 走通发布链路成本远高于收益；
 * 数据看板自身的行为（导入、匹配、判定、统计、建议、降档、角色）全部经 HTTP 断言。
 *
 * 爆款口径说明：默认「账号近 90 天均值 ×3、样本 ≥5」。本脚本构造 12 条同账号 t1 快照
 * （3 条播放 1000 + 9 条播放 100 → 均值 325、阈值 975），恰好 3 条判为爆款；t7 只导入 1 条，
 * 用于验证「样本 <5 → is_hot=null」的样本不足分支。
 */
import { bootIsolated } from './lib/isolated-env.js'
import { authHeader, initSmokeAuth, type SmokeRole } from './lib/smoke-auth.js'

const externalBase = process.env.BASE ?? process.env.SMOKE_BASE ?? ''
const env: Awaited<ReturnType<typeof bootIsolated>> | null = externalBase
  ? null
  : await bootIsolated({ env: { LOG_LEVEL: 'warn' } })
const BASE = externalBase || env!.base
await initSmokeAuth(BASE)

async function exitWith(code: number): Promise<never> {
  await env?.shutdown()
  process.exit(code)
}

let passed = 0
let failed = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed++
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.log(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400))
  }
}

interface Res {
  status: number
  ok?: boolean
  data?: any
  error?: any
}
async function api(method: string, path: string, body?: unknown, asRole?: SmokeRole): Promise<Res> {
  const hasBody = method === 'POST' || method === 'PUT' || method === 'PATCH'
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...authHeader(method, path, asRole),
    },
    body: hasBody ? JSON.stringify(body ?? {}) : undefined,
  })
  const json = (await res.json().catch(() => ({}))) as Res
  return { ...json, status: res.status }
}

/** multipart 导入：field 名 platform / window / file（routes.ts readCsvMultipart） */
async function importCsv(csv: string, platform: string, window: string, asRole: SmokeRole = 'ops'): Promise<Res> {
  const fd = new FormData()
  fd.append('platform', platform)
  fd.append('window', window)
  fd.append('file', new Blob([`\uFEFF${csv}`], { type: 'text/csv' }), 'metrics.csv')
  const res = await fetch(`${BASE}/analytics/metrics/import`, {
    method: 'POST',
    headers: authHeader('POST', '/analytics/metrics/import', asRole),
    body: fd,
  })
  const json = (await res.json().catch(() => ({}))) as Res
  return { ...json, status: res.status }
}

/* ── 造数 ── */

const { getDb } = await import('../src/db/index.js')
const { toDb } = await import('../src/lib/time.js')
const db = getDb()

const stamp = Date.now().toString(36).slice(-6)
const ACC_ID = `pacct_sm_${stamp}`
const ACC_NAME = `冒烟账号-${stamp}`
const T = (i: number) => `冒烟内容-${stamp}-${i + 1}`
const VID = (i: number) => `v_sm_${stamp}_${i + 1}`
const LOG_IDS: string[] = []

/** 北京时间 20:00（UTC 12:00），保证发布时段档稳定落在 18-24 点 */
function atDaysAgo(daysAgo: number): string {
  const now = new Date()
  return toDb(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysAgo, 12, 0, 0)))
}

/**
 * 8~12 天前发布：两个窗口都已到期（T+1 24h / T+7 168h），且仍落在 30 天统计区间内。
 * 不能让 finished_at 落在 24 小时内，否则「到期」计数会随运行时刻漂移。
 */
const finFor = (i: number) => atDaysAgo((i % 5) + 8)
const hoursAgo = (h: number) => toDb(new Date(Date.now() - h * 3600_000))

await db.run(
  'INSERT INTO `platform_account` (`id`, `platform`, `line`, `display_name`, `login_status`, `enabled`, `created_at`, `updated_at`) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  [ACC_ID, 'douyin', 'kos', ACC_NAME, 'active', 1, atDaysAgo(40), atDaysAgo(0)],
)

for (let i = 0; i < 12; i++) {
  const suffix = `${stamp}_${i + 1}`
  const topicId = `topic_sm_${suffix}`
  const copyId = `copy_sm_${suffix}`
  const planId = `plan_sm_${suffix}`
  const logId = `plog_sm_${suffix}`
  const fin = finFor(i)
  // 时长 45 秒 → 「30-60 秒」档；方向统一「基金科普」→ 特征统计可断言唯一 top 值
  await db.run(
    'INSERT INTO `topic` (`id`, `source`, `title`, `direction`, `status`, `created_at`) VALUES (?, ?, ?, ?, ?, ?)',
    [topicId, 'news', T(i), '基金科普', 'assigned', fin],
  )
  await db.run(
    'INSERT INTO `copy` (`id`, `topic_id`, `source`, `status`, `title`, `settings`, `created_at`, `updated_at`) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [copyId, topicId, 'news', 'approved', T(i), JSON.stringify({ durationSeconds: 45 }), fin, fin],
  )
  await db.run(
    'INSERT INTO `publish_plan` (`id`, `copy_id`, `title`, `cover_source`, `status`, `completed_at`, `created_at`) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [planId, copyId, T(i), 'custom', 'completed', fin, fin],
  )
  // 最后一条故意不写 external_video_id：验证「账号 + 标题 + 日期」两级回落的第二级
  await db.run(
    'INSERT INTO `publish_log` (`id`, `plan_id`, `platform`, `account_id`, `source`, `status`, `attempt`, `title`, `finished_at`, `external_video_id`, `created_at`, `updated_at`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [logId, planId, 'douyin', ACC_ID, 'auto', 'published', 1, T(i), fin, i === 11 ? null : VID(i), fin, fin],
  )
  LOG_IDS.push(logId)
}
console.log(`造数完成：账号 ${ACC_NAME}，12 条已发布记录（末条无 external_video_id）`)

const CSV_HEADER = '视频ID,作品标题,账号名称,发布时间,播放量,点赞量,评论量,分享量,收藏量,粉丝增量,完播率'
/** t1 首轮：3 条高播放（1000）+ 9 条低播放（100）→ 均值 325、阈值 975 */
function csvT1(): string {
  const rows = LOG_IDS.map((_, i) => {
    const plays = i < 3 ? 1000 : 100
    return [VID(i), `"${T(i)}"`, ACC_NAME, finFor(i), plays, 20, 5, 2, 3, 1, '38.5%'].join(',')
  })
  return [CSV_HEADER, ...rows].join('\n')
}

/* ══════════════════ [0] 元信息与模板 ══════════════════ */
console.log('\n[0] 元信息 / CSV 模板 / Provider 状态')
{
  const meta = await api('GET', '/analytics/meta')
  check('meta 返回 200', meta.status === 200, meta)
  check('两个窗口（t1 / t7）', meta.data?.windows?.length === 2, meta.data?.windows)
  check('四平台可选', (meta.data?.platforms ?? []).length === 4, meta.data?.platforms)
  check('四份平台模板', (meta.data?.templates ?? []).length === 4, meta.data?.templates?.length)
  check('Provider 未启用（Q1：一期只走 CSV）', meta.data?.provider?.available === false, meta.data?.provider)
  check('Provider 提示语含「CSV」', String(meta.data?.provider?.hint ?? '').includes('CSV'), meta.data?.provider)
  check('调度状态带扫描间隔', Number(meta.data?.scheduler?.intervalMs ?? 0) > 0, meta.data?.scheduler)

  const res = await fetch(`${BASE}/analytics/csv-template?platform=douyin`, {
    headers: authHeader('GET', '/analytics/csv-template'),
  })
  const buf = new Uint8Array(await res.arrayBuffer())
  const text = new TextDecoder('utf-8').decode(buf)
  check('模板下载 200', res.status === 200)
  check('模板为 text/csv', String(res.headers.get('content-type') ?? '').includes('text/csv'))
  // 注意：response.text() 会吞掉 BOM，必须看原始字节（EF BB BF）
  check('模板含 BOM（Excel 中文不乱码）', buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf, [...buf.slice(0, 3)])
  check('模板首列「视频ID」', text.startsWith('视频ID'), text.slice(0, 40))

  const bad = await api('GET', '/analytics/csv-template?platform=weibo')
  check('非法平台下载模板 400', bad.status === 400, bad.error)
}

/* ══════════════════ [1] 无快照的空态（AC-M13） ══════════════════ */
console.log('\n[1] 无快照时的空态与拒绝确认')
{
  const ov = await api('GET', '/analytics/overview?days=7')
  check('overview 200', ov.status === 200, ov.error)
  check('empty=true 引导空态', ov.data?.empty === true, ov.data?.empty)
  check('无数据时卡片全 0', ov.data?.cards?.plays === 0 && ov.data?.cards?.captured === 0, ov.data?.cards)
  check('capture 给出窗口待采数', ov.data?.capture?.t1?.pending === 12, ov.data?.capture)
  check('provider.hint 提示当前为 CSV', String(ov.data?.provider?.hint ?? '').includes('CSV'))

  const ft = await api('GET', '/analytics/features?window=t1&days=30')
  check('features 空态 empty=true', ft.data?.empty === true, ft.data?.empty)
  const cf = await api('POST', '/analytics/features/confirm', { window: 't1', days: 30 })
  check('无数据确认偏好 400', cf.status === 400, cf.error)

  const sg = await api('GET', '/analytics/suggestions')
  check('建议列表初始为空', Array.isArray(sg.data?.items) && sg.data.items.length === 0, sg.data)
}

/* ══════════════════ [2] CSV 导入（AC-M1 / AC-M2） ══════════════════ */
console.log('\n[2] CSV 导入 / 两级匹配 / 覆盖 / 80% 整单拒绝')
{
  const noKey = await importCsv('随便一列,另一列\n1,2', 'douyin', 't1')
  check('缺定位列 → 400 CSV_PARSE_FAILED', noKey.status === 400 && noKey.error?.code === 'CSV_PARSE_FAILED', noKey.error)

  const first = await importCsv(csvT1(), 'douyin', 't1')
  check('t1 导入成功', first.status === 200, first.error)
  check('导入 12 条全部命中', first.data?.imported === 12, first.data)
  check('全部为新增（created=12）', first.data?.created === 12, first.data?.created)
  check('无未匹配行', first.data?.unmatchedCount === 0, first.data?.unmatched)
  check('列映射回显（播放量 → 播放量）', first.data?.mapping?.plays === '播放量', first.data?.mapping)
  check('导入后自动刷新出反哺建议（AC-M8）', Number(first.data?.suggestions ?? 0) >= 2, first.data?.suggestions)

  const again = await importCsv(csvT1(), 'douyin', 't1')
  check('重导同窗口覆盖不新增', again.data?.created === 0 && again.data?.updated === 12, again.data)

  const junk = [CSV_HEADER, ...Array.from({ length: 5 }, (_, i) => `,不存在的标题${i},${ACC_NAME},2026-01-0${i + 1},100,1,1,1,1,1,`)].join(
    '\n',
  )
  const rejected = await importCsv(junk, 'douyin', 't1')
  check(
    '≥80% 不匹配整单拒绝（422 METRIC_UNMATCHED_ROWS）',
    rejected.status === 422 && rejected.error?.code === 'METRIC_UNMATCHED_ROWS',
    rejected.error,
  )
  check('拒绝时返回不匹配明细', (rejected.error?.details?.unmatched ?? []).length >= 5, rejected.error?.details)

  // 第二级匹配：无 external_video_id 的第 12 条，按「账号 + 标题 + 发布日期」命中；不写完播率列 → null（Q5）
  const fallbackCsv = [
    '作品标题,账号名称,发布时间,播放量,点赞量,评论量,分享量,收藏量,粉丝增量',
    `"${T(11)}",${ACC_NAME},${finFor(11)},8000,320,40,12,20,9`,
  ].join('\n')
  const fb = await importCsv(fallbackCsv, 'douyin', 't7')
  check('标题回落命中（t7 导入 1 条）', fb.data?.imported === 1, fb.data)
}

/* ══════════════════ [3] 爆款判定与效果看板（AC-M3 / AC-M5） ══════════════════ */
console.log('\n[3] 爆款判定 / 效果看板聚合 / 筛选')
{
  const ov = await api('GET', '/analytics/overview?days=30&pageSize=50')
  check('overview 200', ov.status === 200, ov.error)
  check('已有快照 → empty=false', ov.data?.empty === false, ov.data?.empty)
  check('发布作品 12 条', ov.data?.cards?.published === 12, ov.data?.cards)
  check('已回采 12 条', ov.data?.cards?.captured === 12, ov.data?.cards)
  check('爆款 3 条（均值 325 ×3 = 975）', ov.data?.cards?.hotCount === 3, ov.data?.cards)
  // 3×1000 + 8×100 + 1×8000（末条取 T+7 最新窗口）= 11800
  check('播放合计按每内容最新窗口上卷', ov.data?.cards?.plays === 11800, ov.data?.cards)

  const items: any[] = ov.data?.contents?.items ?? []
  const hot = items.filter((r) => r.isHot === 1)
  const cold = items.filter((r) => r.isHot === 0)
  const under = items.filter((r) => r.isHot === null)
  check('3 条爆款 / 8 条非爆款', hot.length === 3 && cold.length === 8, { hot: hot.length, cold: cold.length })
  check('T+7 单条样本不足 → isHot=null', under.length === 1, under.map((r) => r.title))
  check('爆款行带判定基准 accountAvgPlays', hot.every((r) => typeof r.accountAvgPlays === 'number'), hot[0])
  check('T+1 播放列有值', items.every((r) => typeof r.playsT1 === 'number'), items[0]?.playsT1)
  check(
    '未取到的完播率保持 null（不补 0，Q5）',
    under.length === 1 && under[0].completionRate === null,
    under[0]?.completionRate,
  )
  check('最新窗口为 T+7 的内容 playsT7=8000', under[0]?.playsT7 === 8000, under[0]?.playsT7)

  check('趋势三条线', (ov.data?.trend?.series ?? []).length === 3, ov.data?.trend?.series?.map((s: any) => s.name))
  check(
    '趋势按日桶对齐',
    (ov.data?.trend?.series ?? []).every((s: any) => s.values.length === ov.data?.range?.dayKeys?.length),
    ov.data?.range,
  )
  check('生产线表现含 KOS', (ov.data?.lines ?? []).some((l: any) => l.line === 'kos' && l.count === 12), ov.data?.lines)
  check('capture.t1 有最近导入时间', !!ov.data?.capture?.t1?.lastCapturedAt, ov.data?.capture?.t1)
  check('capture.t7 待回采 11 条', ov.data?.capture?.t7?.pending === 11, ov.data?.capture?.t7)

  const byLine = await api('GET', '/analytics/overview?days=30&line=manager')
  check('按生产线筛选无记录 → empty', byLine.data?.empty === true, byLine.data?.cards)
  const byPlat = await api('GET', '/analytics/overview?days=30&platform=kuaishou')
  check('按平台筛选无记录 → empty（AC-M13 引导空态）', byPlat.data?.empty === true, byPlat.data?.cards)
  const combo = await api('GET', '/analytics/overview?days=30&line=kos&platform=douyin&pageSize=50')
  check('线 + 平台组合筛选命中 12 条', combo.data?.contents?.total === 12, combo.data?.contents?.total)
  const badLine = await api('GET', '/analytics/overview?line=unknown')
  check('非法 line 400', badLine.status === 400, badLine.error)

  // 补录场景：无 plan_id 的发布记录也要能进看板（LEFT JOIN）；2 小时前完成 → 两个窗口都还没到期
  await db.run(
    'INSERT INTO `publish_log` (`id`, `plan_id`, `platform`, `account_id`, `source`, `status`, `attempt`, `title`, `finished_at`, `created_at`, `updated_at`) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [`plog_manual_${stamp}`, 'douyin', ACC_ID, 'manual', 'published', 0, `补录内容-${stamp}`, hoursAgo(2), hoursAgo(2), hoursAgo(2)],
  )
  const withManual = await api('GET', '/analytics/overview?days=30&pageSize=50')
  check('无关联计划的补录记录也计入', withManual.data?.cards?.published === 13, withManual.data?.cards?.published)
}

/* ══════════════════ [4] 采集调度（AC-M4 / AC-R2） ══════════════════ */
console.log('\n[4] 采集调度：到期登记 pending、不重复采集、角色限制')
{
  const denied = await api('POST', '/analytics/metrics/collect', {}, 'ops')
  check('运营触发采集 403（仅管理员）', denied.status === 403, denied.error)

  const out = await api('POST', '/analytics/metrics/collect', {}, 'admin')
  check('管理员触发采集 200', out.status === 200, out.error)
  check('返回两个窗口结果', (out.data?.windows ?? []).length === 2, out.data?.windows)
  const t1 = (out.data?.windows ?? []).find((w: any) => w.window === 't1')
  const t7 = (out.data?.windows ?? []).find((w: any) => w.window === 't7')
  check('t1 窗口已全部采集（due=0）', t1?.due === 0, t1)
  check('t7 窗口到期 11 条登记 pending', t7?.due === 11 && (t7?.pending ?? []).length === 11, t7)
  check('Provider 未启用时不写空快照（collected=0）', t1?.collected === 0 && t7?.collected === 0, { t1, t7 })
  check('pending 明细带原因', String(t7?.pending?.[0]?.reason ?? '').includes('CSV'), t7?.pending?.[0])

  const again = await api('POST', '/analytics/metrics/collect', {}, 'admin')
  const t7again = (again.data?.windows ?? []).find((w: any) => w.window === 't7')
  check('已有快照的记录不被重复采集', t7again?.due === 11, t7again?.due)

  const health = await api('GET', '/health')
  check('采集后服务健康（异常不外溢，AC-R2）', health.status === 200)
  const news = await api('GET', '/news?page=1&pageSize=1')
  check('资讯域不受影响', news.status === 200, news.error)
  const bench = await api('GET', '/benchmark/accounts')
  check('对标域不受影响', bench.status === 200, bench.error)
}

/* ══════════════════ [5] 特征统计与偏好确认（AC-M6 / AC-M7） ══════════════════ */
console.log('\n[5] 特征沉淀五维度 / 确认偏好 / 单条 active')
{
  const ft = await api('GET', '/analytics/features?window=t1&days=30')
  check('features 200', ft.status === 200, ft.error)
  check('样本 12 条 / 爆款 3 条', ft.data?.sampleCount === 12 && ft.data?.hotCount === 3, ft.data)
  check('五维度齐全', (ft.data?.dims ?? []).length === 5, ft.data?.dims?.map((d: any) => d.key))

  const dim = (key: string) => (ft.data?.dims ?? []).find((d: any) => d.key === key)
  check('时长维度 top = 30-60 秒（45s 档）', dim('duration')?.top?.value === '30-60 秒', dim('duration')?.top)
  check('时长维度爆款占比 100%', dim('duration')?.top?.ratio === 1, dim('duration')?.top)
  check('选题方向 top = 基金科普', dim('direction')?.top?.value === '基金科普', dim('direction')?.top)
  check('封面维度 top = 自定义封面', dim('cover')?.top?.value === '自定义封面', dim('cover')?.top)
  check('发布时间 top = 18-24 点', dim('publishTime')?.top?.value === '18-24 点', dim('publishTime')?.top)
  check('钩子维度以「模板 × 方向」代理（Q3）', String(dim('hook')?.top?.value ?? '').includes('基金科普'), dim('hook')?.top)
  check('未确认时状态为「待确认」', dim('duration')?.status === '待确认', dim('duration')?.status)
  check('返回可注入的依据文案', String(ft.data?.basisText ?? '').includes('侧重'), ft.data?.basisText)

  const t7 = await api('GET', '/analytics/features?window=t7&days=30')
  check('t7 样本不足 → 状态「样本不足」', t7.data?.dims?.every((d: any) => d.status === '样本不足'), t7.data?.dims?.map((d: any) => d.status))

  const denied = await api('POST', '/analytics/features/confirm', { window: 't1', days: 30 }, 'reviewer')
  check('审核员确认偏好 403', denied.status === 403, denied.error)

  const ok = await api('POST', '/analytics/features/confirm', { window: 't1', days: 30 })
  check('确认偏好 200', ok.status === 200, ok.error)
  check('档案状态 active', ok.data?.profile?.status === 'active', ok.data?.profile?.status)
  check('档案记录来源窗口 t1', ok.data?.profile?.windowBasis === 't1', ok.data?.profile?.windowBasis)
  check('注入文案含样本量', String(ok.data?.basisText ?? '').includes('12'), ok.data?.basisText)

  const prof = await api('GET', '/analytics/preference-profile')
  check('preference-profile 回显 active 档案', prof.data?.profile?.id === ok.data?.profile?.id, prof.data)
  check('copy 注入文案非空（供文案工坊消费）', !!prof.data?.injection, prof.data?.injection)

  const ok2 = await api('POST', '/analytics/features/confirm', { window: 't1', days: 30 })
  const activeRows = await db.all<{ c: number }>("SELECT COUNT(*) AS c FROM `preference_profile` WHERE `status` = 'active'")
  check('二次确认后仍只有一条 active（A2）', Number(activeRows[0]?.c) === 1, activeRows)
  check('二次确认生成新档案', ok2.data?.profile?.id !== ok.data?.profile?.id, {
    first: ok.data?.profile?.id,
    second: ok2.data?.profile?.id,
  })
  const archived = await db.all<{ c: number }>("SELECT COUNT(*) AS c FROM `preference_profile` WHERE `status` = 'archived'")
  check('旧档案被归档', Number(archived[0]?.c) === 1, archived)

  const ftAfter = await api('GET', '/analytics/features?window=t1&days=30')
  check(
    '确认后维度状态变「已沉淀」',
    (ftAfter.data?.dims ?? []).filter((d: any) => d.status === '已沉淀').length >= 3,
    ftAfter.data?.dims?.map((d: any) => d.status),
  )
}

/* ══════════════════ [6] 反哺建议（AC-M8 / AC-M11） ══════════════════ */
console.log('\n[6] 反哺建议生成 / 去重 / 确认入选题库 / 忽略')
{
  const denied = await api('POST', '/analytics/suggestions/refresh', { window: 't1', days: 30 }, 'reviewer')
  check('审核员刷新建议 403', denied.status === 403, denied.error)

  const refresh = await api('POST', '/analytics/suggestions/refresh', { window: 't1', days: 30 })
  check('刷新建议 200', refresh.status === 200, refresh.error)
  check('同维度同取值不重复生成（导入时已生成过）', refresh.data?.created === 0, refresh.data)

  const list = await api('GET', '/analytics/suggestions?status=pending')
  const items: any[] = list.data?.items ?? []
  check('待确认建议可列出', items.length >= 2, items.length)
  const dirSug = items.find((s) => s.basis?.dimension === 'direction')
  const otherSug = items.find((s) => s.basis?.dimension !== 'direction')
  check('方向类建议带统计依据', !!dirSug && String(dirSug.basis?.value) === '基金科普', dirSug?.basis)
  check('建议标题带「数据反哺」前缀', String(dirSug?.payload?.title ?? '').startsWith('【数据反哺】'), dirSug?.payload)

  const confirmed = await api('POST', `/analytics/suggestions/${dirSug?.id ?? 'missing'}/confirm`, {})
  check('确认建议 200', confirmed.status === 200, confirmed.error)
  const topicId = confirmed.data?.topicId
  check('确认后返回新选题 id', typeof topicId === 'string' && topicId.length > 0, confirmed.data)

  const topics = await api('GET', '/topics?status=candidate&pageSize=50')
  const topic = (topics.data?.items ?? []).find((t: any) => t.id === topicId)
  check('选题来源 = data_backfeed', topic?.source === 'data_backfeed', topic?.source)
  check('选题状态 = candidate', topic?.status === 'candidate', topic?.status)
  check('选题方向沿用建议取值', topic?.direction === '基金科普', topic?.direction)

  const twice = await api('POST', `/analytics/suggestions/${dirSug?.id ?? 'missing'}/confirm`, {})
  check(
    '重复确认 409 SUGGESTION_ALREADY_DECIDED',
    twice.status === 409 && twice.error?.code === 'SUGGESTION_ALREADY_DECIDED',
    twice.error,
  )

  const dismissed = await api('POST', `/analytics/suggestions/${otherSug?.id ?? 'missing'}/dismiss`, {
    reason: '冒烟忽略',
  })
  check('忽略建议 200 且状态 dismissed', dismissed.status === 200 && dismissed.data?.status === 'dismissed', dismissed.data)
  const dismissTwice = await api('POST', `/analytics/suggestions/${otherSug?.id ?? 'missing'}/dismiss`, {})
  check('已忽略的建议再忽略 409', dismissTwice.status === 409, dismissTwice.error)

  // AC-M11：data_backfeed 的 candidate 直接送入文案工坊必须被拒（走 news 同款规则，不能即-sent）
  const direct = await api('POST', '/topics/send', { topicIds: [topicId] })
  check('candidate 直接送入被 409 拒绝（AC-M11）', direct.status === 409, direct.error)
  check('拒绝原因提示先分配人物', String(direct.error?.message ?? '').includes('分配'), direct.error?.message)
}

/* ══════════════════ [7] 对标优先级降档（AC-M9） ══════════════════ */
console.log('\n[7] 对标监控降档 24 → 6 → 2 → 封顶')
{
  const before = await api('GET', '/analytics/overview?days=30&pageSize=50')
  check(
    '无对标匹配时入口字段为 null（前端隐藏按钮）',
    (before.data?.contents?.items ?? []).every((r: any) => r.benchmark === null),
    before.data?.contents?.items?.[0]?.benchmark,
  )

  const benchId = `bacct_sm_${stamp}`
  await db.run(
    'INSERT INTO `benchmark_account` (`id`, `platform`, `platform_uid`, `nickname`, `monitor_status`, `monitor_interval_hours`, `created_at`) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [benchId, 'douyin', `uid_sm_${stamp}`, `对标账号-${stamp}`, 'on', 24, atDaysAgo(5)],
  )
  await db.run(
    'INSERT INTO `benchmark_video` (`id`, `account_id`, `origin`, `platform`, `video_id`, `title`, `published_at`, `fetched_at`) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [`bvid_sm_${stamp}`, benchId, 'monitor', 'douyin', `bvid_${stamp}`, T(0), atDaysAgo(9), atDaysAgo(1)],
  )

  const after = await api('GET', '/analytics/overview?days=30&pageSize=50')
  const hit = (after.data?.contents?.items ?? []).find((r: any) => r.title === T(0))
  check('命中对标账号的内容给出降档入口', !!hit?.benchmark && hit.benchmark.accountId === benchId, hit?.benchmark)
  check('入口显示当前间隔 24 小时', hit?.benchmark?.intervalHours === 24, hit?.benchmark?.intervalHours)

  const denied = await api('POST', '/analytics/benchmark-priority', { benchmarkAccountId: benchId }, 'reviewer')
  check('审核员降档 403', denied.status === 403, denied.error)

  const s1 = await api('POST', '/analytics/benchmark-priority', { benchmarkAccountId: benchId })
  check('24 → 6', s1.data?.from === 24 && s1.data?.to === 6 && !s1.data?.capped, s1.data)
  const s2 = await api('POST', '/analytics/benchmark-priority', { benchmarkAccountId: benchId })
  check('6 → 2', s2.data?.from === 6 && s2.data?.to === 2 && !s2.data?.capped, s2.data)
  const s3 = await api('POST', '/analytics/benchmark-priority', { benchmarkAccountId: benchId })
  check('2 为下限，不再降档（capped）', s3.data?.to === 2 && s3.data?.capped === true, s3.data)

  const missing = await api('POST', '/analytics/benchmark-priority', { benchmarkAccountId: 'not-exist' })
  check('不存在的对标账号 404', missing.status === 404, missing.error)
  const noBody = await api('POST', '/analytics/benchmark-priority', {})
  check('缺参数 400', noBody.status === 400, noBody.error)
}

/* ══════════════════ [8] 角色与异常边界 ══════════════════ */
console.log('\n[8] 角色守卫 / 异常边界')
{
  const reviewerImport = await importCsv(csvT1(), 'douyin', 't1', 'reviewer')
  check('审核员导入 403', reviewerImport.status === 403, reviewerImport.error)
  const reviewerDismiss = await api('POST', '/analytics/suggestions/whatever/dismiss', {}, 'reviewer')
  check('审核员忽略建议 403', reviewerDismiss.status === 403, reviewerDismiss.error)
  const reviewerRefresh = await api('POST', '/analytics/suggestions/refresh', {}, 'reviewer')
  check('审核员刷新建议 403（无写权）', reviewerRefresh.status === 403, reviewerRefresh.error)

  const badWindow = await api('GET', '/analytics/features?window=t3')
  check('非法 window 回落 t1（不 500）', badWindow.status === 200 && badWindow.data?.window === 't1', badWindow.data?.window)
  const missingSug = await api('POST', '/analytics/suggestions/not-exist/confirm', {})
  check('不存在的建议确认 404', missingSug.status === 404, missingSug.error)

  const unauth = await fetch(`${BASE}/analytics/overview`)
  check('未登录访问 401', unauth.status === 401, unauth.status)
}

const total = passed + failed
console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 存在失败'}（通过 ${passed} / 失败 ${failed}，共 ${total}）`)
await exitWith(failed === 0 ? 0 : 1)
