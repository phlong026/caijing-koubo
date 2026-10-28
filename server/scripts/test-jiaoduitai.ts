/**
 * 校对台审核接入回归（v1.3「平台只出意见」方案）：SQLite + 本地假校对台（node:http），
 * 覆盖送审（含 source 标识）/ 轮询状态映射 / 机审拦截意见退回 / 驳回 / 改稿 resubmit 重审 /
 * 通过直接锁定送审版本 / 拒收 / 409 接管 / 撤回与人工裁决守卫。
 * 运行：npm run test:jiaoduitai
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { disableEnvProxy, pathOf } from './lib/local-http.js'

/* ── 假校对台 ──────────────────────────────────────────────────────── */

// 只连本机假平台：清掉环境代理，否则 axios 会把回环请求交给代理，
// 桩服务收到 absolute-form 的 request-target，按路径精确比对会误判 404（被当成平台拒收）。
disableEnvProxy()

interface Reply {
  status: number
  body: Record<string, unknown>
}
const received: Array<{ submitter: string; content_text: string; source?: string }> = []
let submitReply: Reply = { status: 200, body: {} }
const resubmits: Array<{ reviewNo: string; submitter: string; content_text: string }> = []
let resubmitReply: Reply = { status: 200, body: {} }
const byNo = new Map<string, Record<string, unknown>>()
/** 桩服务未匹配到的请求（脚手架缺陷信号，非业务结果） */
const unmatched: string[] = []

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    const send = (r: Reply) => {
      res.writeHead(r.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(r.body))
    }
    const path = pathOf(req.url)
    if (req.method === 'POST' && path === '/api/reviews/submit') {
      received.push(JSON.parse(raw))
      return send(submitReply)
    }
    const m = /^\/api\/reviews\/by-no\/([^/]+)$/.exec(path)
    const rm = /^\/api\/reviews\/by-no\/([^/]+)\/resubmit$/.exec(path)
    if (req.method === 'POST' && rm) {
      const body = JSON.parse(raw) as { submitter: string; content_text: string }
      resubmits.push({ reviewNo: decodeURIComponent(rm[1]!), ...body })
      return send(resubmitReply)
    }
    if (req.method === 'GET' && m) {
      const r = byNo.get(decodeURIComponent(m[1]!))
      return send(r ? { status: 200, body: r } : { status: 404, body: { error: '审核单不存在' } })
    }
    // 路径没匹配上是测试脚手架的问题，单独记下来，避免伪装成业务失败（「校对台拒收：not found」）
    unmatched.push(`${req.method} ${path}`)
    send({ status: 404, body: { error: 'not found' } })
  })
})
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const port = (server.address() as AddressInfo).port

const temp = mkdtempSync(join(tmpdir(), 'koubo-jiaoduitai-'))
process.env.DB_DRIVER = 'sqlite'
process.env.DB_SQLITE_PATH = join(temp, 'test.db')
process.env.TEMP_DIR = join(temp, 'tmp')
process.env.LOG_LEVEL = 'silent'
process.env.REVIEW_STUB_ENABLED = 'false'
process.env.JIAODUITAI_BASE_URL = `http://127.0.0.1:${port}`

const { initDb, closeAll } = await import('../src/db/index.js')
const { runMigrations } = await import('../src/db/migrate.js')
const { sendSubmission, syncSubmission, runJiaoduitaiSync } = await import('../src/modules/copy/jiaoduitai-sync.js')
const { manualDecision, withdrawReview, getApprovedCopy } = await import('../src/modules/copy/review.js')
const { getSubmission, getCopy, getVersion } = await import('../src/modules/copy/repo.js')
const { contentHash, toPlainText } = await import('../src/modules/copy/text.js')

const db = await initDb()
let passed = 0
let seq = 0
async function test(name: string, fn: () => Promise<void>) {
  await fn()
  passed++
  console.log(`PASS ${name}`)
}

const SECTIONS = [
  { label: '开头', text: '债市进入震荡期。\n\n\n本产品力争稳健增值。' },
  { label: '结尾', text: '历史业绩不代表未来。' },
]

/** 造一篇已提交、等待送校对台的文案 */
async function seed(title = `四季度债市展望${++seq}`) {
  const n = ++seq
  const copyId = `copy_jdt_${n}`
  const versionId = `ver_jdt_${n}`
  const subId = `sub_jdt_${n}`
  const now = '2026-10-27 10:00:00'
  await db.run(
    "INSERT INTO `copy` (`id`, `source`, `status`, `title`, `review_submission_id`, `submitted_version_id`, `created_at`, `updated_at`) VALUES (?, 'manual', 'in_review', ?, ?, ?, ?, ?)",
    [copyId, title, subId, versionId, now, now],
  )
  await db.run(
    "INSERT INTO `copy_version` (`id`, `copy_id`, `draft_id`, `version_no`, `title`, `sections`, `plain_text`, `word_count`, `content_hash`, `origin`, `locked`, `created_by`, `created_at`) VALUES (?, ?, 'draft_x', 1, ?, ?, ?, 30, ?, 'submit', 1, '张晓', ?)",
    [versionId, copyId, title, JSON.stringify(SECTIONS), toPlainText(title, SECTIONS), contentHash(title, SECTIONS), now],
  )
  await db.run(
    "INSERT INTO `review_submission` (`id`, `copy_id`, `copy_version_id`, `status`, `gate_results`, `is_stub`, `created_at`, `updated_at`) VALUES (?, ?, ?, 'submitted', '[]', 0, ?, ?)",
    [subId, copyId, versionId, now, now],
  )
  return { copyId, versionId, subId, title, reviewNo: `R20261027-1000${String(n).padStart(2, '0')}` }
}

/** 送审成功并拿到单号 */
async function seedSent(title?: string) {
  const s = await seed(title)
  submitReply = { status: 200, body: { review_no: s.reviewNo, version: 1, status: 'machine_reviewing', status_label: '机审中' } }
  await sendSubmission(s.subId)
  return s
}

/**
 * 改稿重提（模拟 submitForReview 复用分支的落库结果）：
 * 锁定新版本 + 审核单转身复用（清裁决字段、指向新版本、待 resubmit）+ copy 回到 in_review。
 */
async function reviseAndResubmit(s: Awaited<ReturnType<typeof seed>>, versionNo: number) {
  const n = ++seq
  const newVersionId = `ver_jdt_v2_${n}`
  const now = '2026-10-27 11:00:00'
  const sections = [{ label: '开头', text: '已按审核意见修改，不承诺收益。' }]
  await db.run(
    "INSERT INTO `copy_version` (`id`, `copy_id`, `draft_id`, `version_no`, `title`, `sections`, `plain_text`, `word_count`, `content_hash`, `origin`, `locked`, `created_by`, `created_at`) VALUES (?, ?, 'draft_x', ?, ?, ?, ?, 20, ?, 'submit', 1, '张晓', ?)",
    [newVersionId, s.copyId, versionNo, s.title, JSON.stringify(sections), toPlainText(s.title, sections), contentHash(s.title, sections), now],
  )
  await db.run(
    "UPDATE `review_submission` SET `copy_version_id` = ?, `status` = 'submitted', `external_status` = 'resubmit_pending', `rejected_gate` = NULL, `reason` = NULL, `decided_by` = NULL, `updated_at` = ? WHERE `id` = ?",
    [newVersionId, now, s.subId],
  )
  await db.run("UPDATE `copy` SET `status` = 'in_review', `submitted_version_id` = ?, `review_gate` = 'submitted', `updated_at` = ? WHERE `id` = ?", [
    newVersionId,
    now,
    s.copyId,
  ])
  return { newVersionId }
}

const setRemote = (no: string, body: Record<string, unknown>) => byNo.set(no, { review_no: no, version: 1, ...body })

try {
  await runMigrations(db)

  await test('送审：单号落库、进入第 1 关，正文压掉连续空行，提交人取版本创建人', async () => {
    const s = await seedSent()
    const sub = await getSubmission(s.subId)
    assert.equal(sub?.externalReviewNo, s.reviewNo)
    assert.equal(sub?.status, 'gate1')
    assert.equal((await getCopy(s.copyId))?.reviewGate, 'gate1')
    const last = received.at(-1)!
    assert.equal(last.submitter, '张晓')
    assert.equal(last.source, 'koubo')
    assert.ok(last.content_text.startsWith(`${s.title}\n\n`))
    assert.doesNotMatch(last.content_text, /\n[ \t]*\n[ \t]*\n/)
  })

  await test('轮询：机审高危拦截 → 退回可编辑并带审核意见，人工初审 → 待人工复核', async () => {
    const s = await seedSent()
    setRemote(s.reviewNo, {
      status: 'pending_revise',
      status_label: '待修改',
      machine_result: 'has_risk',
      machine_risk_count: 4,
      machine_high_count: 4,
      findings: [
        {
          severity_label: '高风险',
          rule_name: '[RULE-147] 禁止稳赚不赔等违规表述',
          excerpt: '本产品力争稳健增值',
          description: '存在弱化风险的违规内容',
          suggestion: '删除弱化风险表述',
        },
      ],
    })
    await syncSubmission(s.subId)
    const sub = await getSubmission(s.subId)
    assert.equal(sub?.status, 'rejected')
    assert.equal(sub?.externalStatus, 'pending_revise')
    assert.equal(sub?.rejectedGate, 'external')
    const copy = await getCopy(s.copyId)
    assert.equal(copy?.status, 'rejected')
    assert.ok((copy?.rejectReason ?? '').includes(`校对台机审拦截（审核单 ${s.reviewNo}）共 4 项风险`))
    assert.match(copy?.rejectReason ?? '', /RULE-147/)
    assert.match(copy?.rejectReason ?? '', /原文「本产品力争稳健增值」/)

    setRemote(s.reviewNo, { status: 'first_reviewing', status_label: '初审中' })
    const fresh = await seedSent()
    setRemote(fresh.reviewNo, { status: 'first_reviewing', status_label: '初审中' })
    await syncSubmission(fresh.subId)
    assert.equal((await getSubmission(fresh.subId))?.status, 'pending_manual')
  })

  await test('校对台在审时不能撤回，也不能本地人工裁决', async () => {
    const s = await seedSent()
    await assert.rejects(withdrawReview(s.copyId, '张晓'), /不支持撤回/)
    setRemote(s.reviewNo, { status: 'pending_first' })
    await syncSubmission(s.subId)
    await assert.rejects(manualDecision({ submissionId: s.subId, result: 'approved', operator: 'reviewer' }), /请在校对台处理/)
  })

  await test('通过：平台只出意见不改稿，直接锁定我方送审版本（不新增版本）', async () => {
    const s = await seedSent()
    setRemote(s.reviewNo, { status: 'approved', status_label: '通过' })
    await syncSubmission(s.subId)
    const copy = await getCopy(s.copyId)
    assert.equal(copy?.status, 'approved')
    assert.equal(copy?.approvedVersionId, s.versionId)
    const approved = await getApprovedCopy(s.copyId)
    assert.equal(approved.title, s.title)
    assert.equal(approved.versionId, s.versionId)
    assert.equal((await getSubmission(s.subId))?.status, 'approved')
    assert.equal((await getSubmission(s.subId))?.externalStatus, 'approved')
  })

  await test('通过且返回风险话术（决策 D4）：取稿以校对台话术为准；未配置字段名时回退模板话术', async () => {
    const { config } = await import('../src/config.js')
    const s = await seedSent()
    config.jiaoduitai.riskField = 'risk_tip'
    try {
      setRemote(s.reviewNo, {
        status: 'approved',
        risk_tip: '校对台话术：基金有风险，投资须谨慎。',
      })
      await syncSubmission(s.subId)
      assert.equal((await getApprovedCopy(s.copyId)).riskHint, '校对台话术：基金有风险，投资须谨慎。')
    } finally {
      config.jiaoduitai.riskField = ''
    }
    const s2 = await seedSent()
    setRemote(s2.reviewNo, { status: 'approved', risk_tip: '未配置字段名时不应采用' })
    await syncSubmission(s2.subId)
    const fallback = (await getApprovedCopy(s2.copyId)).riskHint
    assert.ok(fallback && fallback !== '未配置字段名时不应采用')
  })


  await test('驳回：文案退回可编辑，关卡记为校对台审核', async () => {
    const s = await seedSent()
    setRemote(s.reviewNo, { status: 'rejected', status_label: '驳回' })
    await syncSubmission(s.subId)
    const copy = await getCopy(s.copyId)
    assert.equal(copy?.status, 'rejected')
    assert.match(copy?.rejectReason ?? '', /校对台驳回/)
    assert.equal((await getSubmission(s.subId))?.rejectedGate, 'external')
  })

  await test('送审失败：5xx 留待下一轮重试；400 拒收直接退回并写明原因', async () => {
    const a = await seed()
    submitReply = { status: 500, body: { error: '服务端错误' } }
    await sendSubmission(a.subId)
    assert.equal((await getSubmission(a.subId))?.status, 'submitted')

    submitReply = { status: 200, body: { review_no: a.reviewNo, version: 1, status: 'pending_machine', status_label: '待机审' } }
    await runJiaoduitaiSync()
    assert.equal((await getSubmission(a.subId))?.externalReviewNo, a.reviewNo)

    const b = await seed()
    submitReply = { status: 400, body: { error: '正文超长，上限 100000 字符' } }
    await sendSubmission(b.subId)
    const copy = await getCopy(b.copyId)
    assert.equal(copy?.status, 'rejected')
    assert.match(copy?.rejectReason ?? '', /正文超长/)
  })

  await test('409：本单首次送审就撞到平台已有单（他人建的）时不接管，退回并提示改标题', async () => {
    const a = await seed()
    submitReply = { status: 409, body: { error: '稿件存在在审单据', existing_review_no: 'R20261027-080000' } }
    await sendSubmission(a.subId)
    const sub = await getSubmission(a.subId)
    assert.equal(sub?.externalReviewNo, null)
    const copy = await getCopy(a.copyId)
    assert.equal(copy?.status, 'rejected')
    assert.match(copy?.rejectReason ?? '', /修改标题/)
  })

  await test('409：本单上次送审结果未知（5xx / 超时）时接管单号；单号已被别的审核单占用时退回', async () => {
    const a = await seed()
    submitReply = { status: 502, body: { error: '网关超时' } }
    await sendSubmission(a.subId)
    assert.equal((await getSubmission(a.subId))?.status, 'submitted')
    submitReply = { status: 409, body: { error: '稿件存在在审单据', existing_review_no: 'R20261027-090000' } }
    await sendSubmission(a.subId)
    assert.equal((await getSubmission(a.subId))?.externalReviewNo, 'R20261027-090000')

    const b = await seed()
    submitReply = { status: 502, body: { error: '网关超时' } }
    await sendSubmission(b.subId)
    submitReply = { status: 409, body: { error: '稿件存在在审单据', existing_review_no: 'R20261027-090000' } }
    await sendSubmission(b.subId)
    const copy = await getCopy(b.copyId)
    assert.equal(copy?.status, 'rejected')
    assert.match(copy?.rejectReason ?? '', /修改标题/)
  })

  await test('本地落结果失败时不写终态标记，下一轮轮询重试（通过仍是送审版本）', async () => {
    const s = await seedSent()
    setRemote(s.reviewNo, { status: 'approved', status_label: '通过' })
    // 让 onReviewResult 失败：copy 当前审核单不是本单
    await db.run('UPDATE `copy` SET `review_submission_id` = ? WHERE `id` = ?', ['sub_other', s.copyId])
    await assert.rejects(syncSubmission(s.subId), /不是当前文案的审核单/)
    assert.equal((await getSubmission(s.subId))?.externalStatus, 'machine_reviewing')

    await db.run('UPDATE `copy` SET `review_submission_id` = ? WHERE `id` = ?', [s.subId, s.copyId])
    await runJiaoduitaiSync()
    const copy = await getCopy(s.copyId)
    assert.equal(copy?.status, 'approved')
    assert.equal(copy?.approvedVersionId, s.versionId)
    assert.equal((await getSubmission(s.subId))?.externalStatus, 'approved')
    const reviewVersions = await db.get<{ c: number }>(
      "SELECT COUNT(*) AS c FROM `copy_version` WHERE `copy_id` = ? AND `origin` = 'review'",
      [s.copyId],
    )
    assert.equal(Number(reviewVersions?.c), 0)

    const r = await seedSent()
    setRemote(r.reviewNo, { status: 'rejected', status_label: '驳回' })
    await db.run('UPDATE `copy` SET `review_submission_id` = ? WHERE `id` = ?', ['sub_other', r.copyId])
    await assert.rejects(syncSubmission(r.subId), /不是当前文案的审核单/)
    assert.notEqual((await getSubmission(r.subId))?.externalStatus, 'rejected')
  })

  await test('人工驳回 → 改稿重提 → resubmit：单号不变、版本 +1、状态重走机审', async () => {
    const s = await seedSent()
    setRemote(s.reviewNo, { status: 'rejected', status_label: '驳回', reject_detail: '第 3 段收益表述违规', reject_level: 'first' })
    await syncSubmission(s.subId)
    assert.equal((await getCopy(s.copyId))?.status, 'rejected')
    assert.match((await getCopy(s.copyId))?.rejectReason ?? '', /第 3 段收益表述违规/)

    const { newVersionId } = await reviseAndResubmit(s, 2)
    resubmitReply = { status: 200, body: { review_no: s.reviewNo, version: 2, status: 'machine_reviewing', status_label: '机审中' } }
    await sendSubmission(s.subId)
    assert.equal(resubmits.length, 1)
    assert.equal(resubmits[0]!.reviewNo, s.reviewNo)
    assert.equal(resubmits[0]!.submitter, '张晓')
    assert.ok(resubmits[0]!.content_text.startsWith(s.title))
    assert.ok(resubmits[0]!.content_text.includes('已按审核意见修改，不承诺收益。'))
    const sub = await getSubmission(s.subId)
    assert.equal(sub?.status, 'gate1')
    assert.equal(sub?.externalReviewNo, s.reviewNo)
    assert.equal(sub?.externalStatus, 'machine_reviewing')
    assert.equal(sub?.copyVersionId, newVersionId)
    assert.equal((await getCopy(s.copyId))?.reviewGate, 'gate1')

    // 重审通过 → 直接通过新版本
    setRemote(s.reviewNo, { version: 2, status: 'approved', status_label: '通过' })
    await syncSubmission(s.subId)
    const copy = await getCopy(s.copyId)
    assert.equal(copy?.status, 'approved')
    assert.equal(copy?.approvedVersionId, newVersionId)
  })

  await test('机审拦截 → 意见退回 → 改稿重提 → resubmit 沿用同一单号', async () => {
    const s = await seedSent()
    setRemote(s.reviewNo, {
      status: 'pending_revise',
      status_label: '待修改',
      machine_high_count: 2,
      findings: [{ severity_label: '高风险', rule_name: '[RULE-16] 不得使用承诺收益、保本类表述', excerpt: '保底8%', description: '收益承诺', suggestion: '删除' }],
    })
    await syncSubmission(s.subId)
    assert.equal((await getCopy(s.copyId))?.status, 'rejected')

    await reviseAndResubmit(s, 2)
    resubmitReply = { status: 200, body: { review_no: s.reviewNo, version: 2, status: 'pending_machine', status_label: '待机审' } }
    // 平台版本 +1 后查询接口只返回最新版：mock 同步更新，否则同轮轮询会读到旧版拦截态再次退回
    setRemote(s.reviewNo, { version: 2, status: 'pending_machine', status_label: '待机审' })
    await runJiaoduitaiSync()
    const sub = await getSubmission(s.subId)
    assert.equal(sub?.status, 'gate1')
    assert.equal(sub?.externalReviewNo, s.reviewNo)
    assert.equal(resubmits.at(-1)?.reviewNo, s.reviewNo)
  })

  await test('resubmit 被平台拒收（409 并发 / 状态不符）→ 退回写明原因；5xx 留待重试', async () => {
    const s = await seedSent()
    setRemote(s.reviewNo, { status: 'rejected', status_label: '驳回' })
    await syncSubmission(s.subId)
    await reviseAndResubmit(s, 2)

    resubmitReply = { status: 502, body: { error: '网关超时' } }
    await sendSubmission(s.subId)
    assert.equal((await getSubmission(s.subId))?.status, 'submitted')
    assert.equal((await getSubmission(s.subId))?.externalStatus, 'resubmit_pending')

    resubmitReply = { status: 409, body: { error: '该单据已有进行中的重送版本，请勿重复提交' } }
    await sendSubmission(s.subId)
    const copy = await getCopy(s.copyId)
    assert.equal(copy?.status, 'rejected')
    assert.match(copy?.rejectReason ?? '', /拒收改稿重审/)
    // 拒收后平台单作废（终态标记）：不再误复用，也退出轮询
    assert.equal((await getSubmission(s.subId))?.externalStatus, 'resubmit_refused')

    // 再次改稿重提：复用查询不命中 resubmit_refused，走全新审核单送审（模拟 submitForReview 新建分支）
    const n = ++seq
    const v3 = `ver_jdt_v3_${n}`
    const newSub = `sub_jdt_v3_${n}`
    const newNo = `R20261027-9000${String(n).padStart(2, '0')}`
    const sections = [{ label: '开头', text: '再次修改后的正文。' }]
    await db.run(
      "INSERT INTO `copy_version` (`id`, `copy_id`, `draft_id`, `version_no`, `title`, `sections`, `plain_text`, `word_count`, `content_hash`, `origin`, `locked`, `created_by`, `created_at`) VALUES (?, ?, 'draft_x', 3, ?, ?, ?, 20, ?, 'submit', 1, '张晓', '2026-10-27 12:00:00')",
      [v3, s.copyId, s.title, JSON.stringify(sections), toPlainText(s.title, sections), contentHash(s.title, sections)],
    )
    await db.run(
      "INSERT INTO `review_submission` (`id`, `copy_id`, `copy_version_id`, `status`, `gate_results`, `is_stub`, `created_at`, `updated_at`) VALUES (?, ?, ?, 'submitted', '[]', 0, '2026-10-27 12:00:00', '2026-10-27 12:00:00')",
      [newSub, s.copyId, v3],
    )
    await db.run("UPDATE `copy` SET `status` = 'in_review', `submitted_version_id` = ?, `review_submission_id` = ?, `review_gate` = 'submitted' WHERE `id` = ?", [
      v3,
      newSub,
      s.copyId,
    ])
    submitReply = { status: 200, body: { review_no: newNo, version: 1, status: 'machine_reviewing', status_label: '机审中' } }
    await sendSubmission(newSub)
    const freshSub = await getSubmission(newSub)
    assert.equal(freshSub?.status, 'gate1')
    assert.equal(freshSub?.externalReviewNo, newNo)
    assert.notEqual(freshSub?.externalReviewNo, s.reviewNo)
  })

  // 脚手架自检：所有请求都该被假平台的路径表接住；有漏网说明桩与客户端路径不一致，
  // 否则会以「校对台拒收：not found」的形式伪装成业务失败（曾因环境代理改写 request-target 触发）。
  assert.deepEqual(unmatched, [], `假校对台收到未匹配请求：${unmatched.join(', ')}`)

  console.log(`${passed} jiaoduitai groups passed`)
} finally {
  await closeAll()
  server.close()
  rmSync(temp, { recursive: true, force: true })
}
