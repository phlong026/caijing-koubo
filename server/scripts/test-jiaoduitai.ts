/**
 * 校对台审核接入回归：SQLite + 本地假校对台（node:http），覆盖送审 / 轮询状态映射 / 通过取审核后文案 /
 * 驳回 / 拒收 / 409 接管 / 撤回与人工裁决守卫。
 * 运行：npm run test:jiaoduitai
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/* ── 假校对台 ──────────────────────────────────────────────────────── */

interface Reply {
  status: number
  body: Record<string, unknown>
}
const received: Array<{ submitter: string; content_text: string }> = []
let submitReply: Reply = { status: 200, body: {} }
const byNo = new Map<string, Record<string, unknown>>()

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    const send = (r: Reply) => {
      res.writeHead(r.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(r.body))
    }
    if (req.method === 'POST' && req.url === '/api/reviews/submit') {
      received.push(JSON.parse(raw))
      return send(submitReply)
    }
    const m = /^\/api\/reviews\/by-no\/([^/]+)$/.exec(req.url ?? '')
    if (req.method === 'GET' && m) {
      const r = byNo.get(decodeURIComponent(m[1]!))
      return send(r ? { status: 200, body: r } : { status: 404, body: { error: '审核单不存在' } })
    }
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
    assert.ok(last.content_text.startsWith(`${s.title}\n\n`))
    assert.doesNotMatch(last.content_text, /\n[ \t]*\n[ \t]*\n/)
  })

  await test('轮询：机审高危 → 第 2 关，人工初审 → 待人工复核', async () => {
    const s = await seedSent()
    setRemote(s.reviewNo, { status: 'pending_revise', status_label: '待修改' })
    await syncSubmission(s.subId)
    assert.equal((await getSubmission(s.subId))?.status, 'gate2')
    setRemote(s.reviewNo, { status: 'first_reviewing', status_label: '初审中' })
    await syncSubmission(s.subId)
    const sub = await getSubmission(s.subId)
    assert.equal(sub?.status, 'pending_manual')
    assert.equal(sub?.externalStatus, 'first_reviewing')
  })

  await test('校对台在审时不能撤回，也不能本地人工裁决', async () => {
    const s = await seedSent()
    await assert.rejects(withdrawReview(s.copyId, '张晓'), /不支持撤回/)
    setRemote(s.reviewNo, { status: 'pending_first' })
    await syncSubmission(s.subId)
    await assert.rejects(manualDecision({ submissionId: s.subId, result: 'approved', operator: 'reviewer' }), /请在校对台处理/)
  })

  await test('通过：审核后文案落为新锁定版本，视频创作取到的是修改后的文案', async () => {
    const s = await seedSent()
    const reviewed = `${s.title}（修订）\n\n债市进入震荡期，本产品不承诺收益。\n\n历史业绩不代表未来，投资需谨慎。`
    setRemote(s.reviewNo, { status: 'approved', status_label: '通过', content_text: reviewed })
    await syncSubmission(s.subId)
    const copy = await getCopy(s.copyId)
    assert.equal(copy?.status, 'approved')
    assert.notEqual(copy?.approvedVersionId, s.versionId)
    const v = await getVersion(copy!.approvedVersionId!)
    assert.equal(v?.origin, 'review')
    assert.equal(v?.locked, true)
    assert.deepEqual(v?.sections.map((x) => x.label), ['开头', '结尾'])
    const approved = await getApprovedCopy(s.copyId)
    assert.equal(approved.title, `${s.title}（修订）`)
    assert.equal(approved.plainText, reviewed)
    assert.equal((await getSubmission(s.subId))?.externalStatus, 'approved')
  })

  await test('通过且文案未改：直接通过提交版本，不新增版本', async () => {
    const s = await seedSent()
    const plain = [
      { label: '开头', text: '债市进入震荡期。' },
      { label: '结尾', text: '历史业绩不代表未来。' },
    ]
    await db.run('UPDATE `copy_version` SET `sections` = ?, `content_hash` = ? WHERE `id` = ?', [
      JSON.stringify(plain),
      contentHash(s.title, plain),
      s.versionId,
    ])
    setRemote(s.reviewNo, { status: 'approved', content_text: toPlainText(s.title, plain) })
    await syncSubmission(s.subId)
    assert.equal((await getCopy(s.copyId))?.approvedVersionId, s.versionId)
  })

  await test('通过但未返回文案：转人工复核，审核员可兜底裁决', async () => {
    const s = await seedSent()
    setRemote(s.reviewNo, { status: 'approved' })
    await syncSubmission(s.subId)
    const sub = await getSubmission(s.subId)
    assert.equal(sub?.status, 'pending_manual')
    assert.equal(sub?.externalStatus, 'approved')
    assert.equal((await getCopy(s.copyId))?.status, 'in_review')
    const r = await manualDecision({ submissionId: s.subId, result: 'approved', operator: 'reviewer' })
    assert.equal(r.status, 'approved')
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

  await test('409：平台已有本单（上次送审未落库）时接管单号；单号已被别的审核单占用时退回', async () => {
    const a = await seed()
    submitReply = { status: 409, body: { error: '稿件存在在审单据', existing_review_no: 'R20261027-090000' } }
    await sendSubmission(a.subId)
    assert.equal((await getSubmission(a.subId))?.externalReviewNo, 'R20261027-090000')

    const b = await seed()
    await sendSubmission(b.subId)
    const copy = await getCopy(b.copyId)
    assert.equal(copy?.status, 'rejected')
    assert.match(copy?.rejectReason ?? '', /修改标题/)
  })

  console.log(`${passed} jiaoduitai groups passed`)
} finally {
  await closeAll()
  server.close()
  rmSync(temp, { recursive: true, force: true })
}
