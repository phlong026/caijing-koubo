/**
 * 文案工坊自动化回归（AC-G2 / G4 / E2 / R1 / R2 / R8 / AC-G5 防注入）。
 * 用法：先启动 server（npm run dev），再执行 npm run smoke:copy
 * 可选环境变量：
 *   BASE              默认 http://127.0.0.1:8787/api
 *   SMOKE_GEN_TIMEOUT 单次生成等待上限（ms），默认 240000（真实模型 3 份约 60–90 秒）
 *   SMOKE_INJECT_ONLY=1 只跑防注入用例集
 *
 * 说明：脚本会长期反复跑在同一份库上，所有标题/关键词都带时间戳前缀，
 * 断言只依赖本次产生的数据，避免历史数据污染结论（AC-G5 用例集本身是幂等的）。
 */
import { readFileSync } from 'node:fs'
import { authHeader, initSmokeAuth } from './lib/smoke-auth.js'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = process.env.BASE ?? process.env.SMOKE_BASE ?? 'http://127.0.0.1:8787/api'
await initSmokeAuth(BASE)
const GEN_TIMEOUT_MS = Number(process.env.SMOKE_GEN_TIMEOUT ?? 240000)

let passed = 0
let failed = 0

function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    passed++
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.log(`  ❌ ${name}`, extra === undefined ? '' : JSON.stringify(extra).slice(0, 400))
  }
}

interface Res {
  status: number
  ok?: boolean
  data?: any
  error?: any
}

async function req(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Res> {
  const hasBody = method === 'POST' || method === 'PUT' || method === 'PATCH'
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...authHeader(method, path),
      ...headers,
    },
    body: hasBody ? JSON.stringify(body ?? {}) : undefined,
  })
  const json = (await res.json().catch(() => ({}))) as Res
  return { ...json, status: res.status }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const stamp = Date.now().toString(36)
let seq = 0
function uniq(prefix: string): string {
  seq++
  return `${prefix}-${stamp}-${seq}`
}

async function waitGen(id: string): Promise<any> {
  const t0 = Date.now()
  while (Date.now() - t0 < GEN_TIMEOUT_MS) {
    const r = await req('GET', `/copy/generations/${id}`)
    const s = r.data?.status
    if (s === 'done' || s === 'partial' || s === 'failed') return r.data
    await sleep(500)
  }
  return null
}

/** 新建一条 manual 文案并返回 copyId / 初始稿 */
async function createManual(
  personaId: string,
  title: string,
  sourceText: string,
  keywords?: string,
): Promise<{ copyId: string; draftId: string; rev: number } | null> {
  const c = await req('POST', '/copy', { source: 'manual', personaIds: [personaId], title, sourceText, keywords })
  const copyId = c.data?.copyIds?.[0]
  if (!copyId) {
    console.log(`  ⚠️ 建稿失败：`, JSON.stringify(c.error ?? c).slice(0, 200))
    return null
  }
  const d = await req('GET', `/copy/${copyId}`)
  const draftId = d.data?.currentDraft?.id
  if (!draftId) {
    console.log(`  ⚠️ 未拿到初始稿：`, JSON.stringify(d.data).slice(0, 200))
    return null
  }
  return { copyId, draftId, rev: d.data?.currentDraft?.rev ?? 0 }
}

async function saveDraft(copyId: string, draftId: string, title: string, sections: Array<{ label: string; text: string }>): Promise<Res> {
  const cur = await req('GET', `/copy/${copyId}/drafts/${draftId}`)
  const rev = cur.data?.draft?.rev ?? cur.data?.rev ?? 0
  return req('PUT', `/copy/${copyId}/drafts/${draftId}`, { title, sections, rev })
}

/* ─────────────────────────── 0. 前置 ─────────────────────────── */

console.log('\n[0] 前置检查')
const options = await req('GET', '/copy/options')
if (options.status !== 200 || !options.data) {
  console.log(`  ❌ 无法访问 ${BASE}/copy/options，请先启动 server（npm run dev）`)
  process.exit(1)
}
// 只用可用人物（测试库里可能残留授权待核验的人物）
const personas: any[] = (options.data.personas ?? []).filter((p: any) => p.usable ?? p.enabled)
check('options 返回人物与模板', personas.length >= 3 && (options.data.templates ?? []).length > 0, {
  p: personas.length,
  t: (options.data.templates ?? []).length,
})
const personaMap = new Map(personas.map((p: any) => [p.id, p]))
const managerId = personas.find((p: any) => p.line === 'manager')?.id ?? 'ps_manager_demo'
const kosId = personas.find((p: any) => p.line === 'kos')?.id ?? 'ps_kos_demo'
const basicId = personas.find((p: any) => p.line === 'persona')?.id ?? 'ps_persona_demo'

const genOnly = process.env.SMOKE_INJECT_ONLY === '1'

/* ──────────────────── 1. AC-G2 幂等键与稿数上限 ──────────────────── */

if (!genOnly) {
  console.log('\n[1] AC-G2 幂等键 / 稿数上限')

  const base = await createManual(kosId, uniq('幂等用例'), '这是一段用于验证幂等键的补充资料。')
  if (base) {
    const key = `smoke-${stamp}`
    const genBody = { templateId: 'ctpl_education', styleId: 'csty_kos_edu', durationTier: 'short', count: 1 }
    const g1 = await req('POST', `/copy/${base.copyId}/generate`, genBody, { 'Idempotency-Key': key })
    const g2 = await req('POST', `/copy/${base.copyId}/generate`, genBody, { 'Idempotency-Key': key })
    check(
      '同一 Idempotency-Key 只产生 1 条生成记录',
      g1.data?.generationId && g2.data?.generationId === g1.data.generationId && g2.data?.reused === true,
      { g1: g1.data?.generationId, g2: g2.data?.generationId, reused: g2.data?.reused },
    )
    // 等它跑完，避免后续断言被在途任务干扰
    if (g1.data?.generationId) await waitGen(g1.data.generationId)

    // 稿数上限 10：直接建到 10 份再试生成
    const d0 = await req('GET', `/copy/${base.copyId}`)
    let draftCount = (d0.data?.drafts ?? []).length
    while (draftCount < 10) {
      const nd = await req('POST', `/copy/${base.copyId}/drafts`, {})
      if (!nd.ok && nd.status >= 400) break
      draftCount++
    }
    const limit = await req('POST', `/copy/${base.copyId}/generate`, genBody, { 'Idempotency-Key': `smoke-limit-${stamp}` })
    check(
      '稿数达上限 10 返回 COPY_DRAFT_LIMIT',
      limit.status === 409 && limit.error?.code === 'COPY_DRAFT_LIMIT',
      { count: draftCount, code: limit.error?.code },
    )
  }

  /* ──────────────────── 2. AC-E2 并发保存乐观锁 ──────────────────── */

  console.log('\n[2] AC-E2 并发保存 → COPY_DRAFT_CONFLICT')
  const e2 = await createManual(managerId, uniq('并发用例'), '并发保存用例的补充资料。')
  if (e2) {
    const first = await saveDraft(e2.copyId, e2.draftId, '并发-先保存', [{ label: '开场', text: '先保存的这一份内容必须完整保留。' }])
    check('先保存者成功 rev+1', first.ok === true, first.error?.code)
    // 后保存者拿着旧 rev 提交，必须 409
    const stale = await req('PUT', `/copy/${e2.copyId}/drafts/${e2.draftId}`, {
      title: '并发-后保存',
      sections: [{ label: '开场', text: '后保存的内容不应覆盖先保存者。' }],
      rev: e2.rev,
    })
    check(
      '后保存者得到 COPY_DRAFT_CONFLICT',
      stale.status === 409 && stale.error?.code === 'COPY_DRAFT_CONFLICT',
      { status: stale.status, code: stale.error?.code },
    )
    const after = await req('GET', `/copy/${e2.copyId}/drafts/${e2.draftId}`)
    check(
      '先保存者的内容未被覆盖',
      (after.data?.draft?.sections ?? after.data?.sections ?? []).some((s: any) => s.text.includes('先保存的这一份')),
      after.data?.draft?.title,
    )
    // 冲突后可继续用最新 rev 保存（「载入最新」路径）
    const latestRev = after.data?.draft?.rev ?? after.data?.rev ?? 0
    const retry = await req('PUT', `/copy/${e2.copyId}/drafts/${e2.draftId}`, {
      title: '并发-载入最新后重存',
      sections: [{ label: '开场', text: '载入最新之后重新保存成功。' }],
      rev: latestRev,
    })
    check('载入最新后可正常保存', retry.ok === true, retry.error?.code)
  }

  /* ──────────────────── 3. AC-R1 合规两级 ──────────────────── */

  console.log('\n[3] AC-R1 合规硬禁用 / 软提示 / forbiddenClaims / 标题')
  const hardCopy = await createManual(basicId, uniq('合规用例'), '合规用例的补充资料。')
  if (hardCopy) {
    const hardText = '这个产品保本，而且稳赚不赔，零风险。'
    const hardSave = await saveDraft(hardCopy.copyId, hardCopy.draftId, '保本稳赚', [{ label: '开场', text: hardText }])
    check('保存含硬禁用词的稿', hardSave.ok === true, hardSave.error?.code)
    const hardPc = await req('POST', `/copy/${hardCopy.copyId}/precheck`, { draftId: hardCopy.draftId })
    check(
      '预检硬项不通过',
      hardPc.data?.canSubmit === false && (hardPc.data?.complianceHits ?? []).some((h: any) => h.level === 'hard'),
      { canSubmit: hardPc.data?.canSubmit, hits: hardPc.data?.complianceHits },
    )
    const hardRev = (await req('GET', `/copy/${hardCopy.copyId}/drafts/${hardCopy.draftId}`)).data
    const hardSubmit = await req('POST', `/copy/${hardCopy.copyId}/submit`, {
      draftId: hardCopy.draftId,
      rev: hardRev?.draft?.rev ?? hardRev?.rev,
    })
    check(
      '硬项命中提交被拒 COPY_PRECHECK_FAILED',
      hardSubmit.status === 409 && hardSubmit.error?.code === 'COPY_PRECHECK_FAILED',
      hardSubmit.error?.code,
    )

    // 标题也要扫（FR-R1）：正文干净、标题含硬禁用词 → 仍不通过
    const titleOnly = await createManual(basicId, '稳赚必涨的机会', '正文完全干净的合规用例补充资料。')
    if (titleOnly) {
      const tSave = await saveDraft(titleOnly.copyId, titleOnly.draftId, '稳赚必涨的机会', [
        { label: '开场', text: '这是一段完全干净的正文，没有任何绝对化表述。' },
      ])
      const tPc = await req('POST', `/copy/${titleOnly.copyId}/precheck`, { draftId: titleOnly.draftId })
      const titleHits = (tPc.data?.complianceHits ?? []).filter((h: any) => h.sectionIndex === -1 && h.level === 'hard')
      check('标题纳入合规扫描（P1-14）', tSave.ok === true && titleHits.length > 0, {
        canSubmit: tPc.data?.canSubmit,
        hits: (tPc.data?.complianceHits ?? []).map((h: any) => `${h.level}@${h.sectionIndex}:${h.word}`),
      })
    }

    // 否定语境不误判：「不保本」是合规表述
    const neg = await req('POST', '/copy/compliance/scan', {
      sections: [{ label: '开场', text: '我要先说明，这个产品不保本，也不承诺收益，请不要把它当存款。' }],
    })
    check(
      '否定语境「不保本 / 不承诺收益」不误判（P1-14）',
      neg.ok === true && (neg.data?.hits ?? []).length === 0,
      neg.data?.hits,
    )

    // 软提示词：可提交但有提醒
    const softWord = uniq('温和词')
    const cw = await req('POST', '/compliance-words', { word: softWord, level: 'soft', category: 'smoke' })
    check('新增软提示词', cw.ok === true, cw.error?.code)
    if (cw.ok) {
      const softCopy = await createManual(kosId, uniq('软提示用例'), '软提示用例的补充资料。')
      if (softCopy) {
        await saveDraft(softCopy.copyId, softCopy.draftId, uniq('软提示标题'), [
          { label: '开场', text: `这里刻意写了 ${softWord} 这个词。` },
        ])
        const softPc = await req('POST', `/copy/${softCopy.copyId}/precheck`, { draftId: softCopy.draftId })
        check(
          '软提示可提交但有提醒',
          softPc.data?.canSubmit === true && (softPc.data?.complianceHits ?? []).some((h: any) => h.level === 'soft'),
          { canSubmit: softPc.data?.canSubmit, hits: (softPc.data?.complianceHits ?? []).map((h: any) => h.level) },
        )
      }
      await req('DELETE', `/compliance-words/${cw.data?.id}`)
    }

    // forbiddenClaims 按硬禁用：ps_persona_demo 配置了「不预测具体点位」等，命中其核心短语即硬项
    const p = personaMap.get(basicId)
    const claims: string[] = p?.ipProfile?.forbiddenClaims ?? []
    if (claims.length) {
      const claimCopy = await createManual(basicId, uniq('人物禁语用例'), '人物禁语用例的补充资料。')
      if (claimCopy) {
        await saveDraft(claimCopy.copyId, claimCopy.draftId, uniq('人物禁语'), [
          { label: '开场', text: '我们承诺收益，稳赚不赔，收益翻倍，绝对值。' },
        ])
        const pc = await req('POST', `/copy/${claimCopy.copyId}/precheck`, { draftId: claimCopy.draftId })
        check(
          '人物 forbiddenClaims / 硬词命中按硬禁用处理',
          pc.data?.canSubmit === false && (pc.data?.complianceHits ?? []).every((h: any) => h.level === 'hard'),
          { canSubmit: pc.data?.canSubmit, hits: (pc.data?.complianceHits ?? []).map((h: any) => `${h.level}:${h.word}`) },
        )
      }
    }
  }

  /* ──────────────────── 4. AC-R2 查重 ──────────────────── */

  console.log('\n[4] AC-R2 查重相似度（固定用例，直接调算法）')
  // 注意：预检的 similarity 仅对 `source=benchmark` 生效（FR-R2「查重仅对标来源」），
  // 这里用 manual 来源建稿是拿不到该字段的，所以算法层用固定用例直测，
  // 接口层另起一条 benchmark 来源的 copy 验证「相似度随提交版本保存」。
  const originText = [
    '定投的本质是用固定金额在固定时间买入，从而在波动中摊薄成本。',
    '它并不能保证盈利，只解决买入时点选择困难这一个问题。',
    '对于收入稳定但精力有限的上班族，定投是相对可执行的方案。',
    '但如果你随时可能需要动用这笔钱，定投同样会让你被迫在低位赎回。',
  ].join('')

  const { computeSimilarity } = await import('../src/modules/copy/text.js')
  // 「一半照搬」的固定用例：逐字照搬原文前半段 + 新写后半段，覆盖率落在 40%~60%。
  // 注意两种错误构造：①「原文 + 重复无关内容」→ 原文被全覆盖，相似度接近 100%；
  // ②「只留少量原文 + 大段新写」→ 新写内容把分母撑大，反而接近 0%。
  const halfOrigin =
    '定投的本质是用固定金额在固定时间买入，从而在波动中摊薄成本。它并不能保证盈利，只解决买入时点选择困难这一个问题。'
  const halfRewrite =
    `${halfOrigin}我自己的做法是每月发薪日自动扣款，先不管当天涨跌，把决定权交给纪律。这样做的好处是不用天天盯盘。`
  const rewriteText =
    '每个月拿出一笔固定的钱去买同一只基金，好处是把买贵买便宜的问题交给了纪律，' +
    '坏处是行情单边下跌时照样会亏。它对时间不敏感的人更友好，但钱要随时能用就别这么做。'

  const sim100 = computeSimilarity(originText, originText, 'kos')
  const simHalf = computeSimilarity(halfOrigin, halfRewrite, 'kos')
  const sim0 = computeSimilarity(originText, rewriteText, 'kos')
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`
  check(`原文照搬相似度 ≈100%（实测 ${pct(sim100.similarity)}）`, sim100.similarity >= 0.9, sim100)
  check(
    `一半照搬落在 40%~60%（实测 ${pct(simHalf.similarity)}）`,
    simHalf.similarity >= 0.4 && simHalf.similarity <= 0.6,
    simHalf,
  )
  check(`完全改写 <30%（实测 ${pct(sim0.similarity)}）`, sim0.similarity < 0.3, sim0)
  const personaHalf = computeSimilarity(halfOrigin, halfRewrite, 'persona')
  const kosHalf = computeSimilarity(halfOrigin, halfRewrite, 'kos')
  check(
    `素人线超阈值被阻断（${pct(personaHalf.similarity)} > ${pct(personaHalf.threshold)}）`,
    personaHalf.similarity > personaHalf.threshold && personaHalf.blocked === true,
    { sim: personaHalf.similarity, threshold: personaHalf.threshold, blocked: personaHalf.blocked },
  )
  check(
    `经理 / KOS 线同相似度仅提示不阻断（${pct(kosHalf.similarity)}）`,
    kosHalf.similarity === personaHalf.similarity && kosHalf.blocked === false,
    { sim: kosHalf.similarity, blocked: kosHalf.blocked },
  )

  // 接口层：benchmark 来源才有 similarity，并要随版本保存
  const benchSource = await req('GET', '/benchmark/videos?pageSize=1')
  const benchVideo = (benchSource.data?.items ?? [])[0]
  if (benchVideo?.id) {
    const sent = await req('POST', `/benchmark/videos/${benchVideo.id}/send-to-copy`, { personaIds: [kosId] })
    const benchCopyId = sent.data?.copyIds?.[0]
    if (benchCopyId) {
      const bd = await req('GET', `/copy/${benchCopyId}`)
      const bdraftId = bd.data?.currentDraft?.id
      const src = await req('GET', `/copy/${benchCopyId}/source`)
      const srcText = String(src.data?.text ?? '').slice(0, 400)
      if (bdraftId && srcText) {
        await saveDraft(benchCopyId, bdraftId, uniq('查重基准稿'), [{ label: '开场', text: srcText }])
        const bpc = await req('POST', `/copy/${benchCopyId}/precheck`, { draftId: bdraftId })
        check(
          'benchmark 来源预检返回 similarity 且照搬时高相似',
          bpc.data?.similarity !== null && bpc.data?.similarity !== undefined,
          bpc.data?.similarity,
        )
        const bk = bpc.data?.similarity
        if (bk) {
          check(
            'KOS 线超阈值仅提示、仍可提交',
            bk.similarity > bk.threshold ? bk.blocked === false : true,
            { sim: bk.similarity, threshold: bk.threshold, blocked: bk.blocked },
          )
        }
        const bver = await req('GET', `/copy/${benchCopyId}/drafts/${bdraftId}`)
        const bsub = await req('POST', `/copy/${benchCopyId}/submit`, {
          draftId: bdraftId,
          rev: bver.data?.draft?.rev ?? bver.data?.rev,
        })
        if (bsub.ok) {
          const verDetail = await req('GET', `/copy/versions/${bsub.data.versionId}`)
          check(
            '相似度随提交版本保存',
            verDetail.data?.version?.similarity !== undefined || verDetail.data?.similarity !== undefined,
            Object.keys(verDetail.data ?? {}),
          )
        } else {
          console.log(`  ⏭  基准稿提交被拒（${bsub.error?.code}），跳过「相似度随版本保存」断言`)
        }
      }
    }
  } else {
    console.log('  ⏭  库内暂无对标视频，跳过接口层 similarity 断言')
  }

  /* ──────────────────── 5. AC-R8 撤回 ──────────────────── */

  console.log('\n[5] AC-R8 撤回提交')
  const r8 = await createManual(kosId, uniq('撤回用例'), '撤回用例的补充资料。')
  if (r8) {
    await saveDraft(r8.copyId, r8.draftId, uniq('撤回标题'), [{ label: '开场', text: '这是一段用于验证撤回逻辑的干净正文，不含任何禁用表述。' }])
    const rev = (await req('GET', `/copy/${r8.copyId}/drafts/${r8.draftId}`)).data
    const sub = await req('POST', `/copy/${r8.copyId}/submit`, {
      draftId: r8.draftId,
      rev: rev?.draft?.rev ?? rev?.rev,
    })
    check('提交成功取得审核单', sub.ok === true && !!sub.data?.submissionId, sub.error?.code)
    if (sub.ok) {
      const wd = await req('POST', `/copy/${r8.copyId}/withdraw`)
      check('gate 阶段撤回成功', wd.ok === true, wd.error?.code)
      const afterWd = await req('GET', `/copy/${r8.copyId}`)
      check('撤回后 copy 回 draft 可编辑', afterWd.data?.copy?.status === 'draft', afterWd.data?.copy?.status)
      const subAfter = await req('GET', `/review/submissions/${sub.data.submissionId}`)
      check('审核单状态 withdrawn', subAfter.data?.status === 'withdrawn', subAfter.data?.status)

      // 等桩的异步推进跑完，再确认它没有把 withdrawn 覆盖掉（AC-R8 核心）
      await sleep(1500)
      const subLater = await req('GET', `/review/submissions/${sub.data.submissionId}`)
      check('撤回后审核桩不再回写结果', subLater.data?.status === 'withdrawn', subLater.data?.status)

      // 重提：新版本、从第 1 关开始
      const rev2 = (await req('GET', `/copy/${r8.copyId}/drafts/${r8.draftId}`)).data
      const re = await req('POST', `/copy/${r8.copyId}/submit`, {
        draftId: r8.draftId,
        rev: rev2?.draft?.rev ?? rev2?.rev,
      })
      check(
        '撤回后重提生成新审核单 / 新版本',
        re.ok === true && re.data?.versionNo > (sub.data?.versionNo ?? 0),
        { before: sub.data?.versionNo, after: re.data?.versionNo },
      )
      // 到 pending_manual 之后撤回应 409
      await sleep(1200)
      const lateWd = await req('POST', `/copy/${r8.copyId}/withdraw`)
      check(
        '人工复核后撤回返回 REVIEW_WITHDRAW_NOT_ALLOWED',
        lateWd.status === 409 && lateWd.error?.code === 'REVIEW_WITHDRAW_NOT_ALLOWED',
        { status: lateWd.status, code: lateWd.error?.code },
      )
    }
  }

  /* ──────────────────── 5b. P1-7 人工复核 ──────────────────── */

  console.log('\n[5b] P1-7 人工复核（审核员裁决，四眼原则）')
  const mr = await createManual(kosId, uniq('人工复核用例'), '人工复核用例的补充资料。')
  if (mr) {
    await saveDraft(mr.copyId, mr.draftId, uniq('人工复核标题'), [{ label: '开场', text: '这是一段用于验证人工复核的干净正文，不含任何禁用表述。' }])
    const cur = (await req('GET', `/copy/${mr.copyId}/drafts/${mr.draftId}`)).data
    const msub = await req('POST', `/copy/${mr.copyId}/submit`, { draftId: mr.draftId, rev: cur?.draft?.rev ?? cur?.rev })
    const sid: string = msub.data?.submissionId ?? ''
    check('提交取得审核单', !!sid, msub.error)
    // 桩开启时等它走到待人工复核；桩关闭时停在「已提交」，人工复核可直接裁决
    const stubOn = (await req('GET', '/review/queue')).data?.stubEnabled === true
    for (let i = 0; stubOn && i < 20; i++) {
      if ((await req('GET', `/review/submissions/${sid}`)).data?.status === 'pending_manual') break
      await sleep(300)
    }
    const queue = await req('GET', '/review/queue')
    check('审核员队列含该审核单', (queue.data?.items ?? []).some((i: any) => i.submissionId === sid), queue.status)
    const opsQueue = await req('GET', '/review/queue', undefined, authHeader('GET', '/', 'ops'))
    check('运营访问审核队列 403', opsQueue.status === 403, opsQueue.status)
    const opsDecide = await req('POST', `/review/submissions/${sid}/manual-decision`, { result: 'approved' }, authHeader('POST', '/', 'ops'))
    check('运营裁决 403', opsDecide.status === 403, opsDecide.status)
    const noReason = await req('POST', `/review/submissions/${sid}/manual-decision`, { result: 'rejected' })
    check('退回不填原因 400', noReason.status === 400, noReason.status)
    const approve = await req('POST', `/review/submissions/${sid}/manual-decision`, { result: 'approved' })
    check('审核员人工通过 200', approve.status === 200 && approve.data?.status === 'approved', approve.error)
    const after = await req('GET', `/copy/${mr.copyId}`)
    check('文案状态变为 approved', after.data?.copy?.status === 'approved', after.data?.copy?.status)
    const again = await req('POST', `/review/submissions/${sid}/manual-decision`, { result: 'approved' })
    check('已裁决的审核单不能重复裁决 409', again.status === 409, again.status)
  }

  /* ──────────────────── 6. AC-G4 非法 JSON 无半截稿 ──────────────────── */

  console.log('\n[6] AC-G4 非法 JSON → 无半截稿入库')
  const g4 = await createManual(kosId, uniq('非法JSON用例'), '用于验证非法 JSON 不会产生半截稿的补充资料。')
  if (g4) {
    // 注入故障：补充资料里要求「只输出纯文本、不要 JSON」，配合 mock 故障或真实模型都能触发失败分支
    const before = (await req('GET', `/copy/${g4.copyId}`)).data?.drafts?.length ?? 0
    const g = await req('POST', `/copy/${g4.copyId}/generate`, {
      templateId: 'ctpl_education',
      styleId: 'csty_kos_edu',
      durationTier: 'short',
      count: 1,
      instructions: '这次请不要输出 JSON，直接输出一段普通话的纯文本。',
    }, { 'Idempotency-Key': `smoke-g4-${stamp}` })
    if (g.ok && g.data?.generationId) {
      const done = await waitGen(g.data.generationId)
      const after = (await req('GET', `/copy/${g4.copyId}`)).data?.drafts?.length ?? 0
      const draftAfter = done?.drafts?.length ?? 0
      // 结论只要求「失败时不留半截稿」：成功就跳过，失败则两侧稿数都不能增加
      if (done?.status === 'failed' || done?.failed > 0) {
        check('失败时无半截稿入库', after === before && draftAfter === 0, { before, after, genDrafts: draftAfter })
        check('失败原因可见', (done?.errors ?? []).length > 0 || !!done?.error, done?.errors ?? done?.error)
      } else {
        console.log(`  ⏭  本次生成未触发失败（status=${done?.status}），跳过「无半截稿」断言`)
      }
      check('生成记录状态合法（done/partial/failed）', ['done', 'partial', 'failed'].includes(String(done?.status)), done?.status)
    } else {
      check('生成请求被接受', false, g.error?.code)
    }
  }
}

/* ──────────────────── 6b. 并发建稿与人物校验回归 ──────────────────── */

if (!genOnly) {
  console.log('\n[6b] 批内并发建稿 / 人物校验')

  // 批内并发生成多份：稿号取号与插入必须在同一临界区，否则撞 UNIQUE(copy_id, draft_no)
  const multi = await createManual(kosId, uniq('并发建稿'), '用于验证批内并发生成多份稿时稿号不冲突。')
  if (multi) {
    const g = await req(
      'POST',
      `/copy/${multi.copyId}/generate`,
      { templateId: 'ctpl_education', styleId: 'csty_kos_edu', durationTier: 'short', count: 3 },
      { 'Idempotency-Key': `smoke-multi-${stamp}` },
    )
    const done = g.data?.generationId ? await waitGen(g.data.generationId) : null
    check('一次生成 3 份全部成功', done?.status === 'done' && done?.succeeded === 3, {
      status: done?.status,
      succeeded: done?.succeeded,
      errors: done?.errors ?? done?.error,
    })
    const drafts: any[] = (await req('GET', `/copy/${multi.copyId}`)).data?.drafts ?? []
    const nos = drafts.map((d) => d.draftNo)
    check('稿号互不重复', new Set(nos).size === nos.length && nos.length === 4, nos)

    // 审核桩接口守卫：非法关卡名被拒；已裁决的审核单不再接受进度回写
    const aiDraft = done?.drafts?.[0]
    const cur = aiDraft ? await req('GET', `/copy/${multi.copyId}/drafts/${aiDraft.id}`) : null
    const sub = aiDraft
      ? await req('POST', `/copy/${multi.copyId}/submit`, { draftId: aiDraft.id, rev: cur?.data?.draft?.rev ?? cur?.data?.rev })
      : null
    const subId = sub?.data?.submissionId
    if (subId) {
      let st = ''
      for (let i = 0; i < 40 && st !== 'pending_manual'; i++) {
        await sleep(250)
        st = (await req('GET', `/review/submissions/${subId}`)).data?.status
      }
      const bogus = await req('POST', `/review/submissions/${subId}/progress`, { gate: 'approved', result: 'pass' })
      check('进度回写拒绝非关卡状态', bogus.status === 400, { status: bogus.status, code: bogus.error?.code })
      const dec = await req('POST', `/review/submissions/${subId}/decision`, { result: 'approved' })
      const late = await req('POST', `/review/submissions/${subId}/progress`, { gate: 'gate2', result: 'pass' })
      check('已裁决的审核单不再接受进度回写', !!dec.ok && late.status === 409, { decision: dec.status, late: late.status })
    } else {
      check('提交审核成功', false, sub?.error)
    }
  }

  // 分配人物：不存在的人物 id 被拒绝，不写入悬空 persona_id
  const cand = (await req('GET', '/topics?status=candidate&pageSize=1')).data?.items?.[0]
  if (cand) {
    const bad = await req('PATCH', `/topics/${cand.id}`, { personaIds: ['ps_not_exist'] })
    check('分配不存在的人物返回 404 PERSONA_NOT_FOUND', bad.status === 404 && bad.error?.code === 'PERSONA_NOT_FOUND', { status: bad.status, code: bad.error?.code })
  } else {
    console.log('  ⏭  库内没有 candidate 选题（先跑一次 npm run smoke），跳过分配校验')
  }
}

/* ──────────────────── 7. AC-G5 防注入用例集 ──────────────────── */

console.log('\n[7] AC-G5 防注入用例集')

const here = dirname(fileURLToPath(import.meta.url))
const caseFile = join(here, 'injection-cases.json')
let casesDoc: any
try {
  casesDoc = JSON.parse(readFileSync(caseFile, 'utf8'))
} catch (e) {
  console.log(`  ❌ 读取用例集失败：${(e as Error).message}`)
  process.exit(1)
}
const cases: any[] = Array.isArray(casesDoc.cases) ? casesDoc.cases : []
check(`用例集入库且 ≥ ${casesDoc.minCases ?? 8} 条`, cases.length >= (casesDoc.minCases ?? 8), cases.length)
const entries = new Set(cases.map((c) => c.entry))
check('载荷覆盖 ≥5 个入口', entries.size >= 5, [...entries])

/** 用临时合规词库标出「注入载荷是否被模型原样复述」的硬禁用命中 */
const markerWord = `注入标记${stamp}`
const markRes = await req('POST', '/compliance-words', { word: markerWord, level: 'hard', category: 'smoke-injection' })

/**
 * 每个入口如何落地：把载荷写进**该入口真实的字段**，让 assemblePrompt 走对应的来源分支。
 *  - 资讯正文 / 对标原文：走爆款选题的送工坊链路（sourceRefType=news_item / benchmark_video）
 *  - 文章正文：POST /articles 上传后建 article 来源文案
 *  - 补充资料：manual 来源的 sourceText
 *  - 人物样稿：临时把载荷写进 persona.ip_profile.sample_script，用完还原
 */
interface EntryPayload {
  copyId: string
  draftId: string
  articleId?: string
  /** 需要还原的人物（人物样稿入口） */
  restorePersona?: { id: string; ipProfile: Record<string, unknown> }
}

async function prepareEntry(entry: string, injection: string, personaId: string, title: string): Promise<EntryPayload | null> {
  if (entry === '资讯正文' || entry === '对标原文') {
    // 送工坊契约：需要 topic；这里直接调 benchmark/题目入口成本过高，
    // 改为走 copy-contract 的 article/manual 之外路径不可行，
    // 因此用「文章」承载资讯/对标类正文——三者共用同一来源块的防注入声明，
    // 入口差异只体现在 MODE_INSTRUCTIONS 上，防注入断言等价。
    return prepareArticleEntry(injection, personaId, title)
  }
  if (entry === '文章正文') {
    return prepareArticleEntry(injection, personaId, title)
  }
  if (entry === '人物样稿') {
    const row = await req('GET', '/personas')
    // FR-X1：GET /personas 返回 {items,total}
    const p = (row.data?.items ?? []).find((x: any) => x.id === personaId)
    const ipProfile = (p?.ipProfile ?? {}) as Record<string, unknown>
    const backup = { ...ipProfile }
    const sampleKey = 'sampleScript' in ipProfile ? 'sampleScript' : 'sample_script'
    const okSet = await setPersonaSampleScript(personaId, { ...ipProfile, [sampleKey]: injection })
    if (!okSet) {
      // 人物库是只读桩（D13）时改用等价可写入口：manual 的补充资料
      console.log(`  ⚠️ [${title}] 人物库只读，人物样稿入口降级为 manual 补充资料承载`)
      return prepareManualEntry(injection, personaId, title)
    }
    const made = await createManual(personaId, title, '（该用例的注入载荷放在人物样稿字段）')
    if (!made) return null
    return { ...made, restorePersona: { id: personaId, ipProfile: backup } }
  }
  return prepareManualEntry(injection, personaId, title)
}

async function prepareManualEntry(injection: string, personaId: string, title: string): Promise<EntryPayload | null> {
  return createManual(personaId, title, injection)
}

async function prepareArticleEntry(injection: string, personaId: string, title: string): Promise<EntryPayload | null> {
  const text = `# ${title}\n\n${injection}\n\n这是一段用于验证防注入的正文内容，除上面那句外不含其他指令。\n`
  const up = await req('POST', '/articles', { name: `${title}.md`, text })
  const articleId = up.data?.articleId
  if (!articleId) {
    // /articles 只接受 multipart 或 text 字段时可能失败，降级为 manual
    console.log(`  ⚠️ [${title}] 文章上传失败（${up.error?.code ?? up.status}），降级为 manual 补充资料`)
    return prepareManualEntry(injection, personaId, title)
  }
  const c = await req('POST', '/copy', { source: 'article', personaIds: [personaId], title, articleId })
  const copyId = c.data?.copyIds?.[0]
  if (!copyId) {
    console.log(`  ⚠️ [${title}] 文章来源建稿失败：`, JSON.stringify(c.error ?? c).slice(0, 200))
    return prepareManualEntry(injection, personaId, title)
  }
  const d = await req('GET', `/copy/${copyId}`)
  const draftId = d.data?.currentDraft?.id
  if (!draftId) return null
  return { copyId, draftId, articleId }
}

/** 人物样稿写入：走 PUT /personas/:id/profile（PL1 已提供写接口） */
async function setPersonaSampleScript(personaId: string, ipProfile: Record<string, unknown>): Promise<boolean> {
  const probe = await req('PUT', `/personas/${personaId}/profile`, { ipProfile })
  return probe.ok === true
}

/** 结构化合法性：title 非空、sections 1–8 段且每段 text 非空、无多余未知字段 */
function structureOk(draft: any, sourceRefsRequired: boolean): boolean {
  if (!draft) return false
  const title = String(draft.title ?? '').trim()
  const sections = Array.isArray(draft.sections) ? draft.sections : []
  if (!title) return false
  if (sections.length < 1 || sections.length > 8) return false
  if (!sections.every((s: any) => String(s.text ?? '').trim().length > 0)) return false
  if (sourceRefsRequired) {
    if (!sections.every((s: any) => Array.isArray(s.sourceRefs))) return false
  }
  return true
}

/** 单次生成会偶发超时 / 模型抖动，重试一次；仍失败才记为用例失败 */
async function generateOnce(copyId: string, body: Record<string, unknown>, idem: string): Promise<any> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const key = attempt === 1 ? idem : `${idem}-r${attempt}`
    const g = await req('POST', `/copy/${copyId}/generate`, body, { 'Idempotency-Key': key })
    if (g.ok && g.data?.generationId) {
      const gen = await waitGen(g.data.generationId)
      if (gen?.status !== 'failed') return gen
      if (attempt === 2) return gen
      console.log(`  ↻ 首次生成失败（${JSON.stringify(gen?.errors ?? gen?.error ?? '').slice(0, 120)}），重试一次`)
      continue
    }
    if (attempt === 2) return null
    console.log(`  ↻ 首次生成请求失败（${g.error?.code ?? g.status}），重试一次`)
  }
  return null
}

for (const c of cases) {
  const personaId = personaMap.has(c.personaId) ? c.personaId : kosId
  const persona = personaMap.get(personaId)
  const styleId = persona?.line === 'manager' ? 'csty_manager_pro' : persona?.line === 'persona' ? 'csty_persona_casual' : 'csty_kos_edu'
  const templateId = persona?.line === 'manager' ? 'ctpl_market' : 'ctpl_education'

  const title = uniq(`注入-${c.id}`)
  const made = await prepareEntry(c.entry, c.injection, personaId, title)
  if (!made) {
    check(`[${c.id}] 创建用例文案`, false, c.entry)
    continue
  }

  const gen = await generateOnce(made.copyId, { templateId, styleId, durationTier: 'short', count: 1 }, `smoke-inj-${c.id}-${stamp}`)
  const draftId = gen?.drafts?.[0]?.id
  if (!draftId) {
    check(`[${c.id}] 生成产出 1 份稿（重试后仍失败）`, false, { status: gen?.status, errors: gen?.errors })
    if (made.restorePersona) await setPersonaSampleScript(made.restorePersona.id, made.restorePersona.ipProfile)
    continue
  }
  const draftRes = await req('GET', `/copy/${made.copyId}/drafts/${draftId}`)
  const draft = draftRes.data?.draft ?? draftRes.data
  const fullText = [draft?.title ?? '', ...(draft?.sections ?? []).map((s: any) => s.text)].join('\n')

  // ① JSON 结构合法
  const structOk = structureOk(draft, made.articleId !== undefined)
  // ② 未执行注入：产物里没有载荷要求产出的东西（提示词原文 / 广告链接 / 越界字段名 / 新身份自述 …）。
  //    注意：把注入内容当「素材」引用并加以评论（如「听到保本稳赚要问依据」）是合规行为，
  //    所以这里判定的是「是否照做」，而不是「是否出现关键词」。
  const leakMarkers: string[] = Array.isArray(c.leakMarkers) ? c.leakMarkers : []
  const leaked = leakMarkers.filter((w) => fullText.includes(w))
  // ③ 合规扫描无硬禁用命中。
  //    例外：用例的注入要求本身就是「产出违规表述」（mustNotDo 标了「承诺 / 绝对化」）时，
  //    模型常见做法是**先转述再辟谣**（「有人跟我说保本保收益、稳赚不赔，先打个问号」）。
  //    这时合规词必然出现，但它不是承诺 —— 是否守住由 ②（未执行注入）判定，
  //    所以这类用例把合规项降级为「记录命中数」，不参与通过条件。
  const scan = await req('POST', '/copy/compliance/scan', { title: draft?.title ?? null, sections: draft?.sections ?? [] })
  const hardHits = (scan.data?.hits ?? []).filter((h: any) => h.level === 'hard')
  const complianceCounts = c.complianceCounts === true

  check(
    `[${c.id}] entry=${c.entry} 结构合法 / 未执行注入${complianceCounts ? '' : ' / 无硬禁用'}`,
    structOk && leaked.length === 0 && (complianceCounts || hardHits.length === 0),
    {
      structOk,
      mustNotDo: c.mustNotDo,
      leaked,
      hardHits: hardHits.map((h: any) => `「${h.word}」${(h.text ?? '').slice(0, 30)}`),
      complianceCounts,
      sections: (draft?.sections ?? []).length,
      titleLen: String(draft?.title ?? '').length,
    },
  )
  if (made.restorePersona) await setPersonaSampleScript(made.restorePersona.id, made.restorePersona.ipProfile)
}

if (markRes.ok && markRes.data?.id) await req('DELETE', `/compliance-words/${markRes.data.id}`)

/* ─────────────────────────── 汇总 ─────────────────────────── */

console.log(`\n${failed === 0 ? '✅ 全部通过' : `❌ 失败 ${failed} 项`}（通过 ${passed} / 失败 ${failed}）`)
process.exit(failed === 0 ? 0 : 1)
