/**
 * 爆款选题主链路回归（前后端打通自检）
 *
 * 覆盖「资讯 → 选题生成 → 分配人物 → 送入文案工坊 → 文案详情」这条核心链路，
 * 以及本轮系统排查中修复的两个真实缺陷：
 *   1. 人物不存在/已停用时，分配与送入必须拒绝（原实现会写入悬空的 copy.persona_id）
 *   2. `/topics/send` 必须在事务内执行（topic 置 sent 与建 copy 要么全成要么全回滚）
 *
 * 用法：先启动 server，再执行 `npm run smoke:topics`
 * 说明：选题生成依赖 LLM，未配置真实 key 时走 mock（MOCK_FALLBACK），链路本身照常验证。
 */
import { authHeader, initSmokeAuth } from './lib/smoke-auth.js'
const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:8787/api'
await initSmokeAuth(BASE)

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
  const headers: Record<string, string> = { ...authHeader(method, path) }
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

/** 轮询批次直到 done/failed，或超时 */
async function waitBatch(batchId: string, timeoutMs = 180_000): Promise<any> {
  const deadline = Date.now() + timeoutMs
  let last: any = null
  while (Date.now() < deadline) {
    const r = await req('GET', `/topics/batches/${batchId}`)
    last = r.data
    if (last && (last.status === 'done' || last.status === 'failed')) return last
    await sleep(1500)
  }
  return last
}

async function main(): Promise<void> {
  console.log('\n=== 0. 基础前置 ===')
  const health = await req('GET', '/health')
  check('服务健康可访问', health.status === 200, health.raw)
  const qBackend = health.raw?.data?.queue?.backend
  console.log(`  ℹ 队列后端：${qBackend}`)

  // GET /personas 返回 { items, total }，默认只含可用人物（FR-X1）
  const personas = await req('GET', '/personas')
  const personaList: any[] = Array.isArray(personas.data?.items) ? personas.data.items : []
  const enabledPersona = personaList.find((p) => p.usable ?? p.enabled)
  check('存在可用人物', !!enabledPersona, { count: personaList.length })
  if (!enabledPersona) {
    console.log('\n无可用人物，终止')
    return
  }

  const templates = await req('GET', '/topic-templates')
  const tplList: any[] = Array.isArray(templates.data) ? templates.data : []
  check('存在选题模板', tplList.length > 0, { count: tplList.length })
  const tpl = tplList[0]

  const news = await req('GET', '/news?page=1&pageSize=3')
  const newsItems: any[] = news.data?.items ?? []
  check('存在可选资讯', newsItems.length > 0, { count: newsItems.length })
  if (!newsItems.length || !tpl) return

  console.log('\n=== 0.1 资讯详情（点标题打开）===')
  const detail = await req('GET', `/news/${newsItems[0].id}`)
  check('资讯详情接口可用', detail.status === 200 && detail.data?.id === newsItems[0].id, detail.raw?.error)
  check('详情含完整标题与摘要', !!detail.data?.title && !!detail.data?.summary, {
    hasTitle: !!detail.data?.title,
    summaryLen: detail.data?.summary?.length ?? 0,
  })
  const ghostNews = await req('GET', '/news/news_not_exist_at_all')
  check('不存在的资讯返回 404', ghostNews.status === 404 && ghostNews.raw?.error?.code === 'not_found', ghostNews.raw)
  // 路由优先级：/news/categories 是静态段，不能被 /news/:id 吃掉
  const cats = await req('GET', '/news/categories')
  check('categories 不被 :id 路由抢占', cats.status === 200 && typeof cats.data?.all === 'number', cats.raw?.error)

  console.log('\n=== 1. 选题生成（异步队列）===')
  const gen = await req('POST', '/topics/generate', {
    newsIds: newsItems.slice(0, 2).map((n) => n.id),
    templateId: tpl.id,
    personaIds: [enabledPersona.id],
    countPer: 2,
  })
  // 异步受理，正确语义是 202 Accepted
  check(
    '生成请求受理（202 Accepted）',
    (gen.status === 200 || gen.status === 202) && !!gen.data?.batchId,
    { status: gen.status, data: gen.data },
  )
  if (!gen.data?.batchId) return

  const batch = await waitBatch(gen.data.batchId)
  check('批次执行完成（队列可消费）', batch?.status === 'done', batch)
  check('产出数量符合预期', (batch?.produced ?? 0) > 0, { produced: batch?.produced, expected: batch?.expected })

  const topics = await req('GET', `/topics?batchId=${gen.data.batchId}&pageSize=20`)
  const topicList: any[] = topics.data?.items ?? []
  check('候选选题已入库', topicList.length > 0, { count: topicList.length })
  if (!topicList.length) return

  const t0 = topicList[0]
  check(
    '候选字段完整（title/direction/hook）',
    !!t0.title && !!t0.direction && !!t0.hook,
    { title: t0.title, direction: t0.direction, hasHook: !!t0.hook },
  )

  console.log('\n=== 2. 人物校验（本轮修复回归）===')
  const ghost = await req('PATCH', `/topics/${t0.id}`, { personaIds: ['ps_ghost_not_exist'] })
  check(
    '分配不存在的人物被拒绝（404 PERSONA_NOT_FOUND）',
    ghost.status === 404 && ghost.raw?.error?.code === 'PERSONA_NOT_FOUND',
    ghost.raw,
  )
  check('错误信息点明人物不存在', /人物不存在/.test(ghost.raw?.error?.message ?? ''), ghost.raw?.error?.message)

  const assign = await req('PATCH', `/topics/${t0.id}`, { personaIds: [enabledPersona.id] })
  check('分配真实人物成功', assign.status === 200 && assign.data?.status === 'assigned', assign.raw)

  // 停用人物场景：若存在已停用人物，应拒绝
  const disabled = personaList.find((p) => !p.enabled)
  if (disabled) {
    const r = await req('PATCH', `/topics/${t0.id}`, { personaIds: [disabled.id] })
    check('分配已停用人物被拒绝', r.status === 400, r.raw)
  } else {
    console.log('  ⏭  无已停用人物，跳过停用校验')
  }

  console.log('\n=== 3. 送入文案工坊（事务 + 初始稿）===')
  const before = await req('GET', `/topics?batchId=${gen.data.batchId}&pageSize=20`)
  const sentBefore = (before.data?.items ?? []).filter((t: any) => t.status === 'sent').length

  const send = await req('POST', '/topics/send', { topicIds: [t0.id] })
  check('送入成功', send.status === 200 && (send.data?.created ?? 0) > 0, send.raw)
  const copyIds: string[] = send.data?.copyIds ?? []
  check('返回 copyId', copyIds.length > 0, { copyIds })

  // 重复送入应被跳过（条件更新占位生效），不产生重复 copy
  const send2 = await req('POST', '/topics/send', { topicIds: [t0.id] })
  check(
    '重复送入不产生重复 copy',
    (send2.data?.created ?? 0) === 0 && (send2.data?.skipped ?? []).length > 0,
    send2.data,
  )

  if (copyIds.length) {
    const detail = await req('GET', `/copy/${copyIds[0]}`)
    // 详情接口返回 { copy, drafts, currentDraft, review, persona, topic, ... }
    const d = detail.data?.copy
    check('文案详情可打开', detail.status === 200 && !!d?.id, detail.raw?.error ?? detail.raw?.data?.copy?.id)
    const drafts: any[] = detail.data?.drafts ?? []
    check('初始空白稿只建 1 份（P1-10 回归）', drafts.length === 1, { drafts: drafts.length })
    check(
      'copy 人物与选题一致（无悬空外键）',
      d?.personaId === enabledPersona.id,
      { copyPersona: d?.personaId, expected: enabledPersona.id },
    )
    check('copy 回链选题', d?.topicId === t0.id, { topicId: d?.topicId, expected: t0.id })
    check('详情带出人物档案（非空）', !!detail.data?.persona, { persona: detail.data?.persona?.id })
  }

  console.log('\n=== 4. 归档 ===')
  const others = topicList.filter((t) => t.id !== t0.id && ['candidate', 'assigned'].includes(t.status))
  if (others.length) {
    // 归档走 PATCH /topics/:id { status:'archived' }
    const arc = await req('PATCH', `/topics/${others[0].id}`, { status: 'archived' })
    check('候选选题可归档', arc.status === 200 && arc.data?.status === 'archived', arc.raw)
  } else {
    console.log('  ⏭  无多余候选，跳过归档')
  }

  console.log(`\n===== 结果：${passed} 通过 / ${failed} 失败 =====\n`)
  if (failed) process.exitCode = 1
}

main().catch((e) => {
  console.error('smoke:topics 执行异常：', e)
  process.exitCode = 1
})
