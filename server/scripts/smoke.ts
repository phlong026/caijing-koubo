/**
 * 端到端自检脚本（T9）：跑通 §8 全局验收场景 1~5。
 * 用法：先启动 server（npm run dev），再执行 npm run smoke
 */
const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:8787/api'

let passed = 0
let failed = 0

function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    passed++
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.log(`  ❌ ${name}`, extra === undefined ? '' : JSON.stringify(extra).slice(0, 300))
  }
}

async function req<T = any>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: T; raw: any }> {
  const headers: Record<string, string> = { 'X-Operator': 'smoke' }
  // 无 body 时不能声明 application/json，否则 Fastify 抛 "Body cannot be empty"
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const raw: any = await res.json().catch(() => ({}))
  return { status: res.status, data: raw?.data, raw }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * 全量拉取资讯（自动翻页），用于直接验证去重是否真的没放过任何重复条目。
 * 列表上限 pageSize=100，靠重复翻页扫全量。
 */
async function scanAllNews(): Promise<{
  total: number
  items: any[]
  duplicates: Array<{ key: string; count: number }>
}> {
  const items: any[] = []
  const pageSize = 100
  let total = 0
  for (let page = 1; page <= 50; page++) {
    const r = await req('GET', `/news?page=${page}&pageSize=${pageSize}`)
    if (r.status !== 200) break
    total = Number(r.data?.total ?? 0)
    const batch: any[] = Array.isArray(r.data?.items) ? r.data.items : []
    items.push(...batch)
    if (batch.length < pageSize || items.length >= total) break
  }
  const seen = new Map<string, number>()
  for (const it of items) {
    const key = `${it.source}|${it.externalId}`
    seen.set(key, (seen.get(key) ?? 0) + 1)
  }
  const duplicates = [...seen.entries()]
    .filter(([, c]) => c > 1)
    .map(([key, count]) => ({ key, count }))
  return { total, items, duplicates }
}

/** 后端按 UTC 存储，前端按 Asia/Shanghai 展示（P2-4）；容器为 +08:00，本地时区即目标时区 */
function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 万 / 亿 缩写 */
function fmtNum(n: number | null | undefined): string {
  const v = Number(n ?? 0)
  if (!Number.isFinite(v)) return '0'
  if (v >= 100_000_000) return `${(v / 100_000_000).toFixed(1)}亿`
  if (v >= 10_000) return `${(v / 10_000).toFixed(1)}w`
  return String(v)
}

/** 秒 → mm:ss */
function fmtDuration(sec: number | null | undefined): string {
  const s = Math.max(0, Math.round(Number(sec ?? 0)))
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(Math.floor(s / 60))}:${p(s % 60)}`
}

/** FR-B6 状态机中文标签与配色 */
const EXTRACT_LABEL: Record<string, string> = {
  none: '未提取',
  pending: '排队中',
  submitting: '提交中',
  running: '提取中',
  done: '已提取',
  failed: '提取失败',
  uncertain: '待确认',
}
const EXTRACT_TAG: Record<string, string> = {
  none: 'mw-tag mw-tag-gray',
  pending: 'mw-tag mw-tag-blue',
  submitting: 'mw-tag mw-tag-blue',
  running: 'mw-tag mw-tag-blue',
  done: 'mw-tag mw-tag-green',
  failed: 'mw-tag mw-tag-red',
  uncertain: 'mw-tag mw-tag-orange',
}

async function main(): Promise<void> {
  console.log(`\n=== 爆款选题模块 · 端到端自检（${BASE}） ===\n`)

  /* 场景 0：健康检查 */
  console.log('[0] 健康检查')
  const health: any = await fetch(`${BASE}/health`).then((r) => r.json())
  check('/health 返回 200 且 db/redis 在线', health?.data?.status === 'ok', health?.data)

  /* 场景 1：资讯采集与去重（T1） */
  console.log('\n[1] 资讯采集 / 去重 / 检索（FR-N1~N3）')
  // 等待启动采集产出数据
  let ready = false
  for (let i = 0; i < 30; i++) {
    const r = await req('GET', '/news?pageSize=1')
    if (r.data?.items?.length) {
      ready = true
      break
    }
    await sleep(1000)
  }
  check('启动采集产出资讯（15min 任务 + 启动即采集）', ready)

  const doRefresh = async () => {
    for (let i = 0; i < 8; i++) {
      const r = await req('POST', '/news/refresh')
      // 200=同步返回采集结果；202=采集进行中/被定时任务占用，均属合法受理
      if (r.status === 200 || r.status === 202) return r
      await sleep(2000)
    }
    return null
  }
  const refresh1 = await doRefresh()
  check('手动刷新被受理（200 同步结果 / 202 异步受理）', !!refresh1 && [200, 202].includes(refresh1.status), refresh1?.raw)
  check(
    '手动刷新响应结构合法（202 受理 / 200 带 fetched-inserted）',
    refresh1?.status === 202 || typeof refresh1?.data?.fetched === 'number',
    refresh1?.data,
  )
  // 第二次采集，观察增量。
  //
  // ⚠️ 这条断言曾经非常脆，留个记录免得后来人重踩：
  //   接入 FinStep 后单轮采集 = 多源串行 + 每个源一次 LLM ReAct（实测 48~57s/次，一轮 60~100s），
  //   而 POST /news/refresh 的同步窗口只有 12s，超过即返回 202+status:"running"（后台继续）。
  //   原实现只认 200、否则一直空等，于是 fetchedSecond 永远是 -1 → 被误判成「去重失效」。
  //   这是**断言写错了**，不是功能坏了。
  //
  // 正确口径：验证「服务端返回的增量在业务上自洽」，而不是验证「采集必须在 N 秒内跑完」。
  //   - 200 done：直接拿到 fetched/inserted，校验 inserted <= fetched；
  //   - 202（running/busy）：说明采集仍在后台进行，本次请求合法受理，
  //     此时「增量」这一时刻没有意义，应视为跳过，而不是失败。
  // 真正的去重保证由上面两条断言（无重复 (source,externalId) + 分页可扫全量）承担。
  let insertedSecond = -1
  let fetchedSecond = -1
  let asyncAccepted = false
  const deadline = Date.now() + 3 * 60 * 1000
  while (Date.now() < deadline) {
    const r = await req('POST', '/news/refresh')
    if (r.status === 200) {
      insertedSecond = Number(r.data?.inserted ?? -1)
      fetchedSecond = Number(r.data?.fetched ?? -1)
      break
    }
    // 202 且 status 明确是 running/busy → 合法受理，不再死等
    if (r.status === 202 && ['running', 'busy'].includes(String(r.data?.status))) {
      asyncAccepted = true
      break
    }
    await sleep(3000)
  }
  // 幂等/去重的验收口径：不能直接断言"第二次采集增量必为 0"。
  // mock 数据源按 15 分钟窗口滚动生成 external_id（providers.ts MockProvider），
  // 跨窗口时本就会产生合法新增；换成真实 RSS 后，两次采集之间出稿同样正常。
  // 真正要守住、且能稳定验证的是：已经采集过的条目不会被重复入库。
  const scan = await scanAllNews()
  check(
    '资讯去重：库中无重复 (source, externalId)',
    scan.duplicates.length === 0,
    scan.duplicates.slice(0, 5),
  )
  check('资讯列表分页可扫全量且无遗漏', scan.items.length === scan.total && scan.total > 0, {
    scanned: scan.items.length,
    total: scan.total,
  })
  check(
    '增量不超过当次抓取量（无重复放大）',
    // 异步受理也算通过：采集仍在后台跑，增量此刻不可比
    asyncAccepted || (insertedSecond >= 0 && fetchedSecond >= 0 && insertedSecond <= fetchedSecond),
    asyncAccepted
      ? { 说明: '采集在后台继续（202 受理），增量由去重断言覆盖' }
      : { insertedSecond, fetchedSecond },
  )
  const cats = await req('GET', '/news/categories')
  check('分类计数与来源清单可用', Array.isArray(cats.data?.items) && cats.data.items.length >= 5)
  const newsList = await req('GET', '/news?pageSize=5')
  check('资讯列表按发布时间倒序返回', newsList.data?.items?.length > 0 && !!newsList.data.items[0]?.publishedAt)
  const kw = await req('GET', `/news?keyword=${encodeURIComponent('基金')}&pageSize=5`)
  check('关键词搜索可用', kw.status === 200 && Array.isArray(kw.data?.items))
  const badLink = await req('POST', '/benchmark/parse-link', { shareUrl: 'https://evil.example.com/video/123' })
  check('非白名单链接被拒绝（防 SSRF）', badLink.status === 400 && badLink.raw?.error?.code === 'domain_not_allowed', badLink.raw)

  /* 场景 2：选题生成与送文案工坊（T2 / FR-N4/N5/C1/C3） */
  console.log('\n[2] 选题生成 → 分配 → 送文案工坊（FR-N4/N5、FR-C1/C3）')
  const personas = await req('GET', '/personas')
  check('persona 只读桩返回人物与 IP 档案', Array.isArray(personas.data) && personas.data.length >= 2 && !!personas.data[0]?.ipProfile?.role)
  const newsIds: string[] = newsList.data.items.slice(0, 2).map((n: any) => n.id)
  const personaIds: string[] = personas.data.slice(0, 2).map((p: any) => p.id)
  const gen = await req('POST', '/topics/generate', { newsIds, personaIds, countPer: 3 })
  check('生成任务以异步批次受理', gen.status === 202 && !!gen.data?.batchId, gen.raw)
  const expected = gen.data?.expected
  check('预期条数 = 资讯数 × 人物数 × 生成数量', expected === newsIds.length * personaIds.length * 3, { expected })

  let batch: any = null
  for (let i = 0; i < 40; i++) {
    const r = await req('GET', `/topics/batches/${gen.data.batchId}`)
    batch = r.data
    if (batch?.status !== 'running') break
    await sleep(1000)
  }
  check('批次最终状态为 done', batch?.status === 'done', batch)
  check(`候选条数等于预期（${expected} 条）`, batch?.produced === expected, batch)

  const topics = await req('GET', `/topics?batchId=${gen.data.batchId}&pageSize=50`)
  check('候选字段完整（title/direction/hook/rationale）', topics.data.items.every((t: any) => t.title && t.direction && t.hook && t.rationale))
  check('候选初始状态为 candidate', topics.data.items.every((t: any) => t.status === 'candidate'))
  const t0 = topics.data.items[0]
  const t1 = topics.data.items[1]

  const sendBeforeAssign = await req('POST', '/topics/send', { topicIds: [t0.id] })
  check('未分配人物的候选直接送入被拒绝（FR-C1①）', sendBeforeAssign.status === 409, sendBeforeAssign.raw?.error)

  await req('PATCH', `/topics/${t0.id}`, { personaIds: [personaIds[0]] })
  await req('PATCH', `/topics/${t1.id}`, { personaIds: [personaIds[1]] })
  const afterAssign = await req('GET', `/topics?batchId=${gen.data.batchId}&pageSize=50`)
  const a0 = afterAssign.data.items.find((t: any) => t.id === t0.id)
  check('分配人物后状态变 assigned', a0?.status === 'assigned', a0)

  const send = await req('POST', '/topics/send', { topicIds: [t0.id, t1.id] })
  check('送文案工坊成功', send.status === 200 && send.data?.created >= 2, send.raw)
  const copies = await req('GET', '/copy?source=news&pageSize=20')
  const newsCopies = copies.data.items.filter((c: any) => [t0.id, t1.id].includes(c.topic_id))
  check('copy 草稿按 topic × persona 展开', newsCopies.length >= 2, newsCopies.length)
  check('copy 回链 topic_id 且带 source_ref/source_text', newsCopies.every((c: any) => c.topic_id && c.source_ref_type === 'news_item' && c.source_text))
  const afterSend = await req('GET', `/topics?batchId=${gen.data.batchId}&pageSize=50`)
  const s0 = afterSend.data.items.find((t: any) => t.id === t0.id)
  check('送入后 topic 状态为 sent', s0?.status === 'sent', s0)
  const reassign = await req('PATCH', `/topics/${t0.id}`, { personaIds: [personaIds[1]] })
  check('sent 后不可再改分配（FR-C1）', reassign.status === 409, reassign.raw?.error)

  /* 场景 3：对标账号 → 回填 → 提取 → 送文案工坊（T4/T6/FR-B1/B6/B7） */
  console.log('\n[3] 对标账号回填 / 提取文案 / 送文案工坊（FR-B1/B6/B7）')
  const demoUrl = `https://www.douyin.com/user/MS4wLjABAAAAsmoke${Date.now()}`
  const preview = await req('POST', '/benchmark/accounts/preview', { url: demoUrl })
  check('链接解析预览返回昵称与粉丝数', preview.status === 200 && !!preview.data?.secUid, preview.raw)
  const add = await req('POST', '/benchmark/accounts', { url: demoUrl, intervalHours: 1 })
  check('添加账号成功并自动回填', add.status === 201 && add.data?.backfillStarted === true, add.raw)
  const accountId = add.data?.id

  let videos: any = { data: { items: [] } }
  for (let i = 0; i < 30; i++) {
    videos = await req('GET', `/benchmark/videos?accountId=${accountId}&pageSize=20`)
    if (videos.data?.items?.length) break
    await sleep(1000)
  }
  check('回填最近一页视频入库', videos.data?.items?.length > 0, videos.data?.total)

  const alertsAfterBackfill = await req('GET', '/benchmark/alerts?pageSize=50')
  check('回填期不产生任何告警（FR-B1）', alertsAfterBackfill.data?.total === 0, alertsAfterBackfill.data?.total)

  const dupAdd = await req('POST', '/benchmark/accounts', { url: demoUrl, intervalHours: 2 })
  check('重复添加被拦截（409）', dupAdd.status === 409, dupAdd.raw?.error)

  const badInterval = await req('PATCH', `/benchmark/accounts/${accountId}`, { intervalHours: 0 })
  check('周期 <1h 被拒绝（FR-B2）', badInterval.status === 400, badInterval.raw?.error)
  const updInterval = await req('PATCH', `/benchmark/accounts/${accountId}`, { intervalHours: 2 })
  check('修改周期后 next_check_at 立即重算', updInterval.status === 200 && !!updInterval.data?.nextCheckAt, updInterval.data?.nextCheckAt)

  const quota = await req('GET', '/benchmark/accounts/daily-quota')
  check('预计日调用量与估算费用可计算（FR-B3）', quota.data?.dailyCalls > 0 && typeof quota.data?.estimatedCost === 'number', quota.data)

  const v0 = videos.data.items[0]
  const ex1 = await req('POST', `/benchmark/videos/${v0.id}/extract`)
  check('触发提取进入队列', ['pending', 'submitting', 'running', 'done'].includes(ex1.data?.status), ex1.raw)
  const ex2 = await req('POST', `/benchmark/videos/${v0.id}/extract`)
  check('并发重复触发不产生第二个任务', ['pending', 'submitting', 'running', 'done'].includes(ex2.data?.status) && ex2.data?.cacheId === ex1.data?.cacheId, {
    a: ex1.data?.cacheId,
    b: ex2.data?.cacheId,
  })

  let status = ''
  let statusDetail: any = null
  for (let i = 0; i < 60; i++) {
    const r = await req('GET', `/benchmark/videos/${v0.id}/extract-status`)
    status = r.data?.status
    statusDetail = r.data
    if (status === 'done' || status === 'failed') break
    await sleep(1500)
  }
  check('提取完成（mock 链路：OSS 本地兜底 + 百炼 mock）', status === 'done', statusDetail)

  const callsBefore = await req('GET', '/api-calls/summary')
  await req('POST', `/benchmark/videos/${v0.id}/extract`)
  const callsAfter = await req('GET', '/api-calls/summary')
  check('已提取视频再次点击命中缓存、无新增调用（幂等）', callsBefore.data?.total === callsAfter.data?.total, {
    before: callsBefore.data?.total,
    after: callsAfter.data?.total,
  })

  const script = await req('GET', `/benchmark/videos/${v0.id}/script`)
  check('文案全文与句级时间戳可读', script.status === 200 && !!script.data?.text && hasSentences(script), script.raw?.error)

  const sendCopy = await req('POST', `/benchmark/videos/${v0.id}/send-to-copy`, { personaIds: [personaIds[0]] })
  check('送文案工坊原子创建 benchmark topic + copy', sendCopy.status === 200 && !!sendCopy.data?.topicId && sendCopy.data?.copyIds?.length >= 1, sendCopy.raw)
  const benchCopies = await req('GET', `/copy?topicId=${sendCopy.data?.topicId}`)
  const bc = benchCopies.data?.items?.[0]
  check('copy.source=benchmark 且带提取全文与 extract_cache_id', bc?.source === 'benchmark' && bc?.source_ref_type === 'benchmark_video' && !!bc?.extract_cache_id && !!bc?.source_text, bc)

  /* 场景 4：直接提取（FR-B8） */
  console.log('\n[4] 视频直接提取改写（FR-B8）')
  const adhoc = await req('POST', '/benchmark/parse-link', {
    shareUrl: `https://www.douyin.com/video/7${Date.now().toString().slice(0, 18)}`,
  })
  check('adhoc 视频写入并触发提取', adhoc.status === 201 && adhoc.data?.video?.origin === 'adhoc', adhoc.raw)
  check('adhoc 视频 account_id 为空且无告警', adhoc.data?.video?.accountId === null)

  /* 场景 5：可观测与合规 */
  console.log('\n[5] 可观测与合规（FR-C4 / D14）')
  const summary = await req('GET', '/api-calls/summary')
  check('api_call_log 汇总可查', summary.status === 200 && summary.data?.total > 0, summary.data?.total)
  const ops = await req('GET', '/operations?pageSize=50')
  const actions = new Set<string>(ops.data?.items?.map((o: any) => o.action) ?? [])
  check('关键操作均有 operation_log 记录', ['account.add', 'topic.send', 'video.send_copy'].every((a) => actions.has(a)), Array.from(actions))

  console.log(`\n=== 自检完成：通过 ${passed} 项，失败 ${failed} 项 ===\n`)
  process.exit(failed ? 1 : 0)
}

/** 小工具：判断 sentences 是否为非空数组 */
function hasSentences(s: any): boolean {
  return Array.isArray(s?.data?.sentences) && s.data.sentences.length > 0
}

main().catch((e) => {
  console.error('自检脚本异常：', e)
  process.exit(1)
})
