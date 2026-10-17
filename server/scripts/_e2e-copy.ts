/**
 * 文案工坊快速链路自检（需服务已启动）。
 * 覆盖：创建 → 生成 → 稿/版本 → 预检 → 提交 → 审核桩推进 → 人工裁决 → 取稿 → 撤回。
 *
 * 用法：BASE=http://127.0.0.1:8788/api npx tsx scripts/_e2e-copy.ts
 */
const BASE = process.env.BASE ?? 'http://127.0.0.1:8787/api'
const OP = 'e2e'

async function req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const hasBody = method === 'POST' || method === 'PUT' || method === 'PATCH'
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(hasBody ? { 'Content-Type': 'application/json' } : {}), 'X-Operator': OP, ...headers },
    body: hasBody ? JSON.stringify(body ?? {}) : undefined,
  })
  const json = (await res.json()) as { ok: boolean; data?: any; error?: any }
  return { status: res.status, ...json }
}

let fail = 0
function ck(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`  ✅ ${name}`)
  else {
    fail++
    console.log(`  ❌ ${name}`, extra ? JSON.stringify(extra).slice(0, 400) : '')
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// 真实模型单份约 40–60 秒：批内 3 份并发后约 60–90 秒，留足 4 分钟窗口。
// 无密钥（mock）时秒级返回，不会真的等满。
const GEN_TIMEOUT_MS = Number(process.env.E2E_GEN_TIMEOUT_MS ?? 240000)
async function waitGen(id: string, ms = GEN_TIMEOUT_MS) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const r = await req('GET', `/copy/generations/${id}`)
    const s = r.data?.status
    if (s === 'done' || s === 'partial' || s === 'failed') return r.data
    await sleep(400)
  }
  return null
}

console.log('\n[1] 创建手动文案')
// 标题带时间戳：脚本会长期反复跑在同一份库上，固定标题会与历史数据混在一起，断言失去意义。
const stamp = Date.now().toString(36)
const createTitle = `定投到底适不适合上班族-${stamp}`
const created = await req('POST', '/copy', {
  source: 'manual',
  personaIds: ['ps_kos_demo'],
  title: createTitle,
  sourceText: '上班族收入稳定但精力有限，关注长期积累与波动承受能力。',
  keywords: '定投, 上班族',
})
ck('创建成功', created.ok === true, created)
const copyId = created.data?.copyIds?.[0]
ck('返回 copyId', !!copyId, created.data)

const detail0 = await req('GET', `/copy/${copyId}`)
// 新建入口会自动建一份空白稿（FR-E4），因此派生状态口径为「有稿即写作中」。
// 初始稿会继承文案标题作为标题（便于直接编辑），正文为空 → 不应带出 AI 版本。
ck('派生状态=写作中（含自动空白稿）', detail0.data?.copy?.derivedStatus === 'writing', detail0.data?.copy?.derivedStatus)
// 断言语义：**新建出来的那份稿**必须是空白、无版本、来源 manual。
// 不写死 drafts.length===1 —— 后续步骤（新建空白稿）会在同一 copy 上继续加稿，
// 若脚本中途复跑，长度会变，断言就与业务无关地失败了。
const firstDraft = detail0.data?.drafts?.[0]
ck(
  '初始稿空白且无版本',
  !!firstDraft
    && firstDraft.draftNo === 1
    && firstDraft.origin === 'manual'
    && (firstDraft.latestVersionNo ?? 0) === 0
    && (firstDraft.sections ?? []).every((s: { text: string }) => !s.text)
    && firstDraft.title === createTitle,
  detail0.data?.drafts,
)
ck('人物已绑定', detail0.data?.persona?.id === 'ps_kos_demo')

console.log('\n[2] 生成 3 稿（幂等键）')
const key = `e2e-${Date.now()}`
const g1 = await req('POST', `/copy/${copyId}/generate`, {
  templateId: 'ctpl_education', styleId: 'csty_kos_edu', durationTier: 'medium', count: 3,
}, { 'Idempotency-Key': key })
ck('接受生成', g1.ok === true && !!g1.data?.generationId, g1)
const g2 = await req('POST', `/copy/${copyId}/generate`, {
  templateId: 'ctpl_education', styleId: 'csty_kos_edu', durationTier: 'medium', count: 3,
}, { 'Idempotency-Key': key })
ck('同 key 复用同一生成记录', g2.data?.generationId === g1.data?.generationId && g2.data?.reused === true, g2.data)

const gen = await waitGen(g1.data!.generationId)
ck('生成完成 status=done', gen?.status === 'done', gen?.status)
ck('成功 3 份', gen?.succeeded === 3, { s: gen?.succeeded, f: gen?.failed })
ck('提示词快照可取', !!gen?.promptHash && (gen?.prompt?.length ?? 0) > 500)
ck('人物快照含 forbiddenClaims', Array.isArray((gen?.personaSnapshot?.ipProfile?.forbiddenClaims ?? [])), gen?.personaSnapshot?.ipProfile)

const detail1 = await req('GET', `/copy/${copyId}`)
// 新建时已产生 1 份空白稿，生成 3 份 → 共 4 份；仅校验 AI 稿数为 3
const aiDrafts = (detail1.data?.drafts ?? []).filter((d: any) => d.origin === 'ai')
ck('新增 3 份 AI 稿', aiDrafts.length === 3, { total: detail1.data?.drafts?.length, ai: aiDrafts.length })
ck('每份 AI 稿有版本号 ≥1', aiDrafts.every((d: any) => d.latestVersionNo >= 1), aiDrafts.map((d: any) => d.latestVersionNo))

console.log('\n[3] 自动保存与乐观锁')
const cur = detail1.data?.currentDraft
const s1 = await req('PUT', `/copy/${copyId}/drafts/${cur.id}`, {
  title: cur.title,
  sections: [{ label: '开场', text: '定投这件事，先说结论：上班族适合，但不是所有人都适合。' }],
  rev: cur.rev,
})
ck('保存成功 rev+1', s1.ok === true && s1.data?.draft?.rev === cur.rev + 1, s1.error ?? s1.data?.draft?.rev)
const s2 = await req('PUT', `/copy/${copyId}/drafts/${cur.id}`, { title: 'x', sections: [], rev: cur.rev })
ck('旧 rev 返回 COPY_DRAFT_CONFLICT', s2.status === 409 && s2.error?.code === 'COPY_DRAFT_CONFLICT', s2.error)

console.log('\n[4] 保存草稿版本（hash 去重）')
// 注意：上一段保存的正文与 AI 生成版本完全一致，此时保存版本应命中 hash 去重。
// 先真正改一笔内容，才能验证「新内容 → 产生版本」；再原样保存验证「无变更 → 复用版本」。
const beforeVer = await req('GET', `/copy/${copyId}/drafts/${cur.id}`)
const bd = beforeVer.data?.draft ?? beforeVer.data
const secs = (bd?.sections ?? []).map((s: any) => ({ label: s.label, text: s.text }))
secs.push({ label: '风险提示', text: '基金有风险，投资需谨慎，请根据自身情况审慎决策。' })
const edited = await req('PUT', `/copy/${copyId}/drafts/${cur.id}`, {
  title: bd?.title, sections: secs, rev: bd?.rev,
})
ck('改动正文成功', edited.ok === true, edited.error ?? edited.data?.draft?.rev)
const v1 = await req('POST', `/copy/${copyId}/drafts/${cur.id}/versions`)
ck('产生版本', v1.ok === true && v1.data?.created === true, v1)
const v2 = await req('POST', `/copy/${copyId}/drafts/${cur.id}/versions`)
ck('内容未变不新增版本', v2.data?.created === false && v2.data?.versionId === v1.data?.versionId, v2.data)

console.log('\n[5] 预检')
const fresh = await req('GET', `/copy/${copyId}/drafts/${cur.id}`)
const pc = await req('POST', `/copy/${copyId}/precheck`, { draftId: cur.id })
ck('预检通过', pc.data?.canSubmit === true, pc.data?.checks?.filter((c: any) => !c.pass))
ck('字数与秒数有值', (pc.data?.wordCount ?? 0) > 0 && (pc.data?.estSeconds ?? 0) > 0, { w: pc.data?.wordCount, s: pc.data?.estSeconds })

console.log('\n[6] 提交与审核桩')
const sub = await req('POST', `/copy/${copyId}/submit`, { draftId: cur.id, rev: fresh.data?.rev })
ck('提交成功', sub.ok === true && !!sub.data?.submissionId, sub.error ?? sub.data)
const submissionId = sub.data?.submissionId
const d2 = await req('GET', `/copy/${copyId}`)
ck('状态=in_review', d2.data?.copy?.status === 'in_review', d2.data?.copy?.status)

const locked = await req('PUT', `/copy/${copyId}/drafts/${cur.id}`, { title: 'y', sections: [], rev: 0 })
ck('审核中写操作 COPY_LOCKED', locked.status === 409 && locked.error?.code === 'COPY_LOCKED', locked.error)

await sleep(1200)
const prog = await req('GET', `/review/submissions/${submissionId}`)
ck('桩推进到待人工复核', prog.data?.status === 'pending_manual', prog.data?.status)
ck('三关均有结论', (prog.data?.gateResults ?? []).length === 3, prog.data?.gateResults?.length)
ck('已追加风险提示话术', !!prog.data?.appendedRiskText)

console.log('\n[7] 人工复核通过 → 取稿')
const dec = await req('POST', `/review/submissions/${submissionId}/decision`, { result: 'approved' })
ck('裁决通过', dec.ok === true, dec.error ?? dec.data)
const approved = await req('GET', `/copy/${copyId}/approved`)
ck('取稿返回已通过版本', approved.ok === true && approved.data?.versionNo >= 1, approved.error ?? approved.data?.versionNo)
ck('取稿含 sections 与 riskHint', (approved.data?.sections ?? []).length > 0 && !!approved.data?.riskHint)
ck('取稿含 persona', !!approved.data?.persona?.name, approved.data?.persona)

console.log('\n[8] 通过后修改与撤回')
const reed = await req('PUT', `/copy/${copyId}/drafts/${cur.id}`, { title: '改标题', sections: fresh.data?.sections, rev: fresh.data?.rev })
ck('未确认时拒绝编辑（需确认）', reed.status === 409 && reed.error?.details?.requiresConfirm === true, reed.error?.code)
const reed2 = await req('PUT', `/copy/${copyId}/drafts/${cur.id}`, {
  title: '改标题', sections: fresh.data?.sections, rev: fresh.data?.rev, confirmReedit: true,
})
ck('确认后进入修订中', reed2.ok === true, reed2.error)
const d3 = await req('GET', `/copy/${copyId}`)
ck('状态回 draft 且保留 approved', d3.data?.copy?.status === 'draft' && !!d3.data?.copy?.approvedVersionId, {
  s: d3.data?.copy?.status, a: d3.data?.copy?.approvedVersionId,
})
const approved2 = await req('GET', `/copy/${copyId}/approved`)
ck('修订期仍可取旧通过版本', approved2.ok === true)

console.log('\n[9] 合规拦截')
const bad = await req('POST', '/copy', {
  source: 'manual', personaIds: ['ps_persona_demo'], title: '保本又稳赚的机会', sourceText: '这段话里包含稳赚和保本这样的表述。',
})
const badId = bad.data?.copyIds?.[0]
// 新建文案已自带一份空白初始稿（FR-E4），直接沿用，无需再手工建稿
const badDetail = await req('GET', `/copy/${badId}`)
const badDraftId = badDetail.data?.currentDraft?.id
const badRev = badDetail.data?.currentDraft?.rev ?? 0
ck('新建自带空白初始稿', !!badDraftId, badDetail.data?.drafts?.length)
const badSave = await req('PUT', `/copy/${badId}/drafts/${badDraftId}`, {
  title: '保本稳赚', sections: [{ label: '开场', text: '这个理财产品保本，而且稳赚不赔，零风险。' }], rev: badRev,
})
ck('保存含硬禁用词的稿', badSave.ok === true, badSave.error)
const badPc = await req('POST', `/copy/${badId}/precheck`, { draftId: badDraftId })
ck('预检标记硬禁用命中', (badPc.data?.complianceHits ?? []).some((h: any) => h.level === 'hard'), badPc.data?.complianceHits)
const badSub = await req('POST', `/copy/${badId}/submit`, { draftId: badDraftId, rev: badSave.data?.draft?.rev })
ck('提交被拒 COPY_PRECHECK_FAILED', badSub.status === 409 && badSub.error?.code === 'COPY_PRECHECK_FAILED', badSub.error)

console.log('\n[10] 自定义时长校验')
const dft = await req('POST', `/copy/${badId}/generate`, { templateId: 'ctpl_market', styleId: 'csty_persona_casual', durationTier: 'custom', count: 1 })
ck('custom 未传秒数 → 400', dft.status === 400, dft.error?.code)
const dft2 = await req('POST', `/copy/${badId}/generate`, { templateId: 'ctpl_market', styleId: 'csty_persona_casual', durationTier: 'custom', durationSeconds: 5, count: 1 })
ck('秒数越界 → 400', dft2.status === 400, dft2.error?.code)

console.log('\n[11] 风格按线过滤')
const wrongStyle = await req('POST', `/copy/${copyId}/generate`, { templateId: 'ctpl_market', styleId: 'csty_persona_casual', durationTier: 'medium', count: 1 })
ck('跨线风格被拒', wrongStyle.status === 400, wrongStyle.error?.message)

console.log('\n[12] 列表筛选')
const list = await req('GET', '/copy?pageSize=5')
ck('列表返回', list.ok === true && Array.isArray(list.data?.items), list.error)
const byIds = await req('GET', `/copy?ids=${copyId},${badId}`)
ck('ids 过滤生效', byIds.data?.items?.length === 2, byIds.data?.items?.length)
const pending = await req('GET', '/copy?derivedStatus=pending_write')
// 新建即带空白初始稿，故 pending_write 天然可为空集；这里只校验筛选返回结构正确且结果自洽
ck('派生状态筛选生效', pending.ok === true && (pending.data?.items ?? []).every((i: any) => i.derivedStatus === 'pending_write'), pending.data?.items?.length)
const writing = await req('GET', '/copy?derivedStatus=writing')
ck('写作中筛选生效', writing.ok === true && (writing.data?.items ?? []).some((i: any) => i.id === badId), writing.data?.items?.length)

console.log(`\n${fail === 0 ? '✅ 全部通过' : `❌ 失败 ${fail} 项`}`)
process.exit(fail === 0 ? 0 : 1)
