import { describe, expect, it } from 'vitest'
import { serializeReview } from '../../src/modules/copy/service.js'
import type { SubmissionRow } from '../../src/modules/copy/repo.js'

function sub(overrides: Partial<SubmissionRow> = {}): SubmissionRow {
  return {
    id: 'sub_x',
    copyId: 'copy_x',
    copyVersionId: 'ver_x',
    status: 'gate1',
    gateResults: [{ gate: 'gate1', result: 'pass', reason: '已送校对台（审核单 R1）：机审中', riskPoints: null, confidence: null, at: '2026-10-28T03:00:00.000Z' }],
    appendedRiskText: null,
    rejectedGate: null,
    reason: null,
    decidedBy: null,
    isStub: false,
    externalReviewNo: 'R1',
    externalStatus: 'machine_reviewing',
    createdAt: '2026-10-28 10:00:00',
    updatedAt: '2026-10-28 10:01:00',
    ...overrides,
  }
}

describe('serializeReview（详情 / 审核进度共用的审核单序列化）', () => {
  it('已送校对台的单：带 externalStatus / 审核单号，驳回原因优先取审核单', () => {
    const r = serializeReview(sub({ reason: '校对台驳回…' }), { versionNo: 2, submittedBy: '张晓' })
    expect(r.channel).toBe('jiaoduitai')
    expect(r.externalStatus).toBe('machine_reviewing')
    expect(r.externalReviewNo).toBe('R1')
    expect(r.statusLabel).toBe('预检中（合规）')
    expect(r.rejectReason).toBe('校对台驳回…')
    expect(r.versionNo).toBe(2)
    expect(r.submittedBy).toBe('张晓')
    expect(r.decidedAt).toBeNull()
  })

  it('无单号但校对台已接入 → 等待补送（jiaoduitai）；桩单标记 stub', () => {
    const r = serializeReview(sub({ externalReviewNo: null }), { versionNo: 1, submittedBy: '张晓' })
    // 本机 .env 配置了校对台地址：已接入时未送出的单也归校对台渠道（等待补送）
    expect(r.channel).toBe('jiaoduitai')
    const stub = serializeReview(sub({ isStub: true }), { versionNo: 1, submittedBy: '张晓' })
    expect(stub.channel).toBe('stub')
  })

  it('审核单无退回原因时回退文案的 rejectReason；裁决后 decidedAt 取更新时间', () => {
    const r = serializeReview(
      sub({ status: 'rejected', reason: null, decidedBy: 'reviewer', rejectedGate: 'external' }),
      { versionNo: 1, submittedBy: '张晓', copyRejectReason: '文案级驳回原因' },
    )
    expect(r.rejectReason).toBe('文案级驳回原因')
    expect(r.rejectedGate).toBe('external')
    expect(r.decidedAt).toBe('2026-10-28 10:01:00')
  })
})
