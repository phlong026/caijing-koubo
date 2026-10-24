import { describe, expect, it } from 'vitest'
import {
  needAttentionOf,
  normalizeCopyNode,
  normalizeEditNode,
  normalizePublishNode,
  normalizeTopicNode,
  normalizeVideoNode,
  stageOf,
  taskStatusOf,
  type CopyLite,
  type CutLite,
  type PublishPlanLite,
  type ReviewLite,
  type VideoJobLite,
} from '../../src/modules/task-center/normalize.js'
import { buildTaskSummary, type Aggregates, type SourceKey } from '../../src/modules/task-center/service.js'

const copy = (over: Partial<CopyLite> = {}): CopyLite => ({
  id: 'cp_abcdef1234567890abcd',
  title: '测试文案',
  topicId: null,
  status: 'draft',
  approvedVersionId: null,
  currentDraftId: null,
  reviewGate: null,
  line: 'manager',
  createdBy: 'alice',
  personaName: '张三',
  ownerSubject: null,
  updatedAt: '2026-10-24T00:00:00.000Z',
  ...over,
})

const review = (over: Partial<ReviewLite> = {}): ReviewLite => ({ status: 'gate1', rejectedGate: null, ...over })

const job = (over: Partial<VideoJobLite> = {}): VideoJobLite => ({
  versionNo: 1,
  phase: 'generating',
  progressFloor: 38,
  statusMessage: '口播画面生成中',
  errorCode: null,
  timelineSource: null,
  remoteTaskId: 'task-1',
  remoteResultUrl: null,
  updatedAt: '2026-10-24T01:00:00.000Z',
  ...over,
})

const plan = (over: Partial<PublishPlanLite> = {}): PublishPlanLite => ({
  id: 'pl_1',
  status: 'scheduled',
  reviewState: 'none',
  updatedAt: '2026-10-24T02:00:00.000Z',
  ...over,
})

const cut = (over: Partial<CutLite> = {}): CutLite => ({
  id: 'vcut_1',
  videoJobId: 'vj_1',
  versionNo: 1,
  status: 'completed',
  renderStage: 'uploading',
  progress: 100,
  reviewStatus: 'none',
  errorCode: null,
  updatedAt: '2026-10-24T03:00:00.000Z',
  ...over,
})

describe('任务中心状态归一（任务书 §3.2 全分支）', () => {
  it('选题节点：无 topic 省略；candidate 待分配；assigned/sent 已完成', () => {
    expect(normalizeTopicNode(null)).toBeNull()
    expect(normalizeTopicNode({ id: 't1', title: 'x', status: 'candidate' })?.statusLabel).toBe('待分配人物')
    expect(normalizeTopicNode({ id: 't1', title: 'x', status: 'assigned' })?.tone).toBe('done')
    expect(normalizeTopicNode({ id: 't1', title: 'x', status: 'sent' })?.statusLabel).toBe('已进入创作')
    expect(normalizeTopicNode({ id: 't1', title: 'x', status: 'archived' })?.statusLabel).toBe('已进入创作')
  })

  it('稿件节点：rejected 退回可重投；in_review 展示关卡；审核中不算需处理', () => {
    const rejected = normalizeCopyNode(copy({ status: 'rejected' }), review({ status: 'rejected' }), { latest: 3, approved: null }, false)
    expect(rejected.statusLabel).toBe('已退回')
    expect(rejected.tone).toBe('error')
    expect(rejected.action).toBe('revise_resubmit')

    const g2 = normalizeCopyNode(copy({ status: 'in_review', reviewGate: 'gate2' }), review({ status: 'gate2' }), { latest: 3, approved: null }, false)
    expect(g2.statusLabel).toBe('审核中 · 第 2 关')
    expect(g2.tone).toBe('wait')
    expect(g2.action).toBe('view_review')

    const nodes = [normalizeCopyNode(copy({ status: 'in_review' }), review(), { latest: 1, approved: null }, false)]
    expect(needAttentionOf(nodes)).toBe(false)
  })

  it('稿件节点：approved 且无视频给 create_video；有视频无动作；draft 三态派生', () => {
    const approvedNoJob = normalizeCopyNode(copy({ status: 'approved', approvedVersionId: 'v3' }), review({ status: 'approved' }), { latest: 4, approved: 3 }, false)
    expect(approvedNoJob.statusLabel).toBe('已通过 v3')
    expect(approvedNoJob.action).toBe('create_video')

    const approvedWithJob = normalizeCopyNode(copy({ status: 'approved', approvedVersionId: 'v3' }), review({ status: 'approved' }), { latest: 4, approved: 3 }, true)
    expect(approvedWithJob.actions).toEqual([])

    const revising = normalizeCopyNode(copy({ approvedVersionId: 'v2', currentDraftId: 'd1' }), null, { latest: 3, approved: 2 }, false)
    expect(revising.statusKey).toBe('revising')
    expect(revising.action).toBe('continue_write')

    const writing = normalizeCopyNode(copy({ currentDraftId: 'd1' }), null, { latest: 1, approved: null }, false)
    expect(writing.statusKey).toBe('writing')

    const pending = normalizeCopyNode(copy(), null, { latest: null, approved: null }, false)
    expect(pending.statusKey).toBe('pending_write')
    expect(pending.action).toBe('write_copy')
  })

  it('基础视频节点：进行中显示进度与查看进度（含混剪 tts/composing）', () => {
    const gen = normalizeVideoNode(job(), false)
    expect(gen.tone).toBe('doing')
    expect(gen.statusLabel).toBe('口播画面生成中')
    expect(gen.progress).toBe(38)
    expect(gen.action).toBe('view_progress')

    const composing = normalizeVideoNode(job({ phase: 'composing', progressFloor: 55, statusMessage: null }), false)
    expect(composing.statusLabel).toBe('素材合成中')
    expect(composing.action).toBe('view_progress')

    const tts = normalizeVideoNode(job({ phase: 'tts', progressFloor: 2, statusMessage: null }), false)
    expect(tts.action).toBe('view_progress')
  })

  it('基础视频节点：completed 动作对齐 nextActionsOf（estimated 另有 realign）', () => {
    const done = normalizeVideoNode(job({ phase: 'completed', progressFloor: 100, timelineSource: 'aligned' }), false)
    expect(done.tone).toBe('done')
    expect(done.statusLabel).toBe('已生成 v1')
    expect(done.actions).toEqual(['continue_edit'])

    const estimated = normalizeVideoNode(job({ phase: 'completed', timelineSource: 'estimated' }), false)
    expect(estimated.actions).toEqual(['continue_edit', 'realign'])
  })

  it('基础视频节点：容错动作透传——save_failed 不给 query_original；unknown 按任务号二选一', () => {
    const saveOk = normalizeVideoNode(job({ phase: 'save_failed', remoteResultUrl: 'https://x', remoteTaskId: null }), false)
    expect(saveOk.actions).toEqual(['retry_download'])

    const saveStuck = normalizeVideoNode(job({ phase: 'save_failed', remoteResultUrl: null, remoteTaskId: null }), false)
    expect(saveStuck.actions).toEqual([])

    const unknownWithTask = normalizeVideoNode(job({ phase: 'submission_unknown', remoteTaskId: 't1' }), false)
    expect(unknownWithTask.actions).toEqual(['query_original'])

    const unknownNoTask = normalizeVideoNode(job({ phase: 'submission_unknown', remoteTaskId: null }), false)
    expect(unknownNoTask.actions).toEqual(['bind_remote'])

    const failed = normalizeVideoNode(job({ phase: 'failed', errorCode: 'VENDOR_500' }), false)
    expect(failed.tone).toBe('error')
    expect(failed.statusLabel).toContain('VENDOR_500')
    expect(failed.action).toBe('regenerate')

    const paused = normalizeVideoNode(job({ phase: 'paused' }), false)
    expect(paused.tone).toBe('wait')
    expect(paused.action).toBe('view_progress')

    const cancelled = normalizeVideoNode(job({ phase: 'cancelled' }), false)
    expect(cancelled.statusLabel).toBe('已取消')
    // §3.2：已取消 → regenerate（VideoCreate 对 cancelled 已开放重新生成入口）
    expect(cancelled.action).toBe('regenerate')

    const notStarted = normalizeVideoNode(null, false)
    expect(notStarted.actions).toEqual([])
    const readyToCreate = normalizeVideoNode(null, true)
    expect(readyToCreate.action).toBe('create_video')
  })

  it('发布节点：动作对齐 nextActionOf + manual_confirm 补充推导', () => {
    const noPlanReady = normalizePublishNode(null, [], true)
    expect(noPlanReady.statusLabel).toBe('待安排发布')
    expect(noPlanReady.action).toBe('create_plan')

    const noPlanWaiting = normalizePublishNode(null, [], false)
    expect(noPlanWaiting.actions).toEqual([])

    const draft = normalizePublishNode(plan({ status: 'draft' }), [], false)
    expect(draft.action).toBe('create_plan')

    const scheduled = normalizePublishNode(plan({ status: 'scheduled' }), [], false)
    expect(scheduled.statusLabel).toBe('已排期')
    expect(scheduled.action).toBe('view_logs')

    const needsReview = normalizePublishNode(plan({ status: 'scheduled', reviewState: 'needs_review' }), [], false)
    expect(needsReview.statusKey).toBe('needs_review')
    expect(needsReview.tone).toBe('wait')
    expect(needsReview.action).toBe('wait_review')

    const manual = normalizePublishNode(plan({ status: 'executing' }), ['confirming', 'verification_required'], false)
    expect(manual.statusKey).toBe('manual')
    expect(manual.tone).toBe('error')
    expect(manual.action).toBe('manual_confirm')

    const partial = normalizePublishNode(plan({ status: 'partial' }), ['published', 'failed_final'], false)
    expect(partial.tone).toBe('error')
    expect(partial.action).toBe('retry')

    const published = normalizePublishNode(plan({ status: 'completed' }), ['published'], false)
    expect(published.statusKey).toBe('published')
    expect(published.actions).toEqual([])

    const cancelled = normalizePublishNode(plan({ status: 'cancelled' }), [], false)
    expect(cancelled.statusLabel).toBe('已取消')
    expect(cancelled.actions).toEqual([])
  })

  it('剪辑节点（TC9 真实化）：无 cut 按视频是否完成二分；草稿行 = 剪辑配置中', () => {
    const notStarted = normalizeEditNode(null, false)
    expect(notStarted.statusKey).toBe('not_started')
    expect(notStarted.actions).toEqual([])

    const notCut = normalizeEditNode(null, true)
    expect(notCut.statusKey).toBe('not_cut')
    expect(notCut.action).toBe('create_cut')

    const draft = normalizeEditNode(cut({ versionNo: 0, status: 'draft', renderStage: 'idle', progress: 0 }), false)
    expect(draft.statusKey).toBe('editing')
    expect(draft.tone).toBe('doing')
    expect(draft.action).toBe('continue_edit')
  })

  it('剪辑节点：渲染主链 queued/rendering/cancelling 显示阶段与进度', () => {
    const queued = normalizeEditNode(cut({ status: 'queued', renderStage: 'idle', progress: 0 }), false)
    expect(queued.statusKey).toBe('rendering')
    expect(queued.statusLabel).toBe('排队渲染')
    expect(queued.action).toBe('view_cut_progress')

    const rendering = normalizeEditNode(cut({ status: 'rendering', renderStage: 'subtitle', progress: 46 }), false)
    expect(rendering.statusLabel).toBe('渲染中 · 烧录字幕')
    expect(rendering.progress).toBe(46)
    expect(rendering.refId).toBe('vj_1')

    const cancelling = normalizeEditNode(cut({ status: 'cancelling', renderStage: 'bgm', progress: 60 }), false)
    expect(cancelling.statusKey).toBe('rendering')
  })

  it('剪辑节点：failed/cancelled 容错分支', () => {
    const failed = normalizeEditNode(cut({ status: 'failed', errorCode: 'FFMPEG_EXIT_1', progress: 30 }), false)
    expect(failed.statusKey).toBe('cut_failed')
    expect(failed.tone).toBe('error')
    expect(failed.statusLabel).toContain('FFMPEG_EXIT_1')
    expect(failed.action).toBe('retry_cut')

    const cancelled = normalizeEditNode(cut({ status: 'cancelled', progress: 0 }), false)
    expect(cancelled.statusKey).toBe('cut_cancelled')
    expect(cancelled.tone).toBe('todo')
    expect(cancelled.action).toBe('continue_edit')
  })

  it('剪辑节点：completed × 复审四态（none/in_review/rejected/approved）', () => {
    const pending = normalizeEditNode(cut({ reviewStatus: 'none' }), false)
    expect(pending.statusKey).toBe('cut_review_pending')
    expect(pending.statusLabel).toBe('已渲染 v1 · 待提交复审')
    expect(pending.action).toBe('continue_edit')

    const inReview = normalizeEditNode(cut({ reviewStatus: 'in_review' }), false)
    expect(inReview.statusKey).toBe('cut_in_review')
    expect(inReview.tone).toBe('wait')
    expect(inReview.action).toBe('view_cut_review')

    const rejected = normalizeEditNode(cut({ reviewStatus: 'rejected' }), false)
    expect(rejected.statusKey).toBe('cut_rejected')
    expect(rejected.tone).toBe('error')
    expect(rejected.action).toBe('continue_edit')

    const approved = normalizeEditNode(cut({ reviewStatus: 'approved' }), false)
    expect(approved.statusKey).toBe('cut_approved')
    expect(approved.tone).toBe('done')
    expect(approved.actions).toEqual([])
    expect(approved.title).toBe('成片 v1')
  })

  it('任务级状态：需处理 > 已取消 > 已完成 > 进行中；剪辑未参与链路不计入活动节点', () => {
    const videoFailed = [normalizeCopyNode(copy({ status: 'approved' }), review({ status: 'approved' }), { latest: 1, approved: 1 }, true), normalizeVideoNode(job({ phase: 'failed' }), false), normalizePublishNode(null, [], false)]
    expect(taskStatusOf(videoFailed)).toBe('attention')

    const videoCancelled = [normalizeVideoNode(job({ phase: 'cancelled' }), false), normalizePublishNode(plan({ status: 'scheduled' }), [], false)]
    expect(taskStatusOf(videoCancelled)).toBe('cancelled')

    const allDone = [
      normalizeCopyNode(copy({ status: 'approved', approvedVersionId: 'v1' }), review({ status: 'approved' }), { latest: 1, approved: 1 }, true),
      normalizeVideoNode(job({ phase: 'completed' }), false),
      normalizePublishNode(plan({ status: 'completed' }), ['published'], true),
    ]
    expect(taskStatusOf(allDone)).toBe('completed')

    // 未剪辑（可选环节）不参与链路推进：全 done 时活动节点落发布，也不产生需处理
    const withNotCut = [...allDone, normalizeEditNode(null, true)]
    expect(stageOf(withNotCut).key).toBe('publish')
    expect(needAttentionOf(withNotCut)).toBe(false)

    // 剪辑渲染失败 → 需处理；活动节点为剪辑
    const cutFailedNodes = [
      normalizeCopyNode(copy({ status: 'approved', approvedVersionId: 'v1' }), review({ status: 'approved' }), { latest: 1, approved: 1 }, true),
      normalizeVideoNode(job({ phase: 'completed' }), false),
      normalizeEditNode(cut({ status: 'failed', errorCode: 'FFMPEG_EXIT_1' }), false),
      normalizePublishNode(null, [], true),
    ]
    expect(needAttentionOf(cutFailedNodes)).toBe(true)
    expect(taskStatusOf(cutFailedNodes)).toBe('attention')
    expect(stageOf(cutFailedNodes).key).toBe('edit')

    // 成片被退回同样计入需处理
    const cutRejected = [normalizeEditNode(cut({ reviewStatus: 'rejected' }), false)]
    expect(needAttentionOf(cutRejected)).toBe(true)

    // 复审中不算需处理（审核台有专门队列，TC5 口径）
    const cutInReview = [normalizeEditNode(cut({ reviewStatus: 'in_review' }), false)]
    expect(needAttentionOf(cutInReview)).toBe(false)

    const pendingWrite = [normalizeCopyNode(copy(), null, { latest: null, approved: null }, false), normalizeVideoNode(null, false), normalizePublishNode(null, [], false)]
    expect(taskStatusOf(pendingWrite)).toBe('in_progress')
    expect(stageOf(pendingWrite).key).toBe('copy')
  })

  it('需处理：needs_review 计入（复审不确认无法发布）', () => {
    const nodes = [normalizeCopyNode(copy({ status: 'approved', approvedVersionId: 'v1' }), review({ status: 'approved' }), { latest: 1, approved: 1 }, true), normalizeVideoNode(job({ phase: 'completed' }), false), normalizePublishNode(plan({ status: 'scheduled', reviewState: 'needs_review' }), [], false)]
    expect(needAttentionOf(nodes)).toBe(true)
    expect(taskStatusOf(nodes)).toBe('attention')
  })
})

describe('聚合降级（AC-R1：单来源异常只降级对应节点）', () => {
  const aggWith = (failed: SourceKey[], over: Partial<Aggregates> = {}): Aggregates => ({
    topics: new Map(),
    reviews: new Map(),
    versions: new Map([[copy().id, { latest: 1, approved: 1 }]]),
    jobs: new Map(),
    cuts: new Map(),
    plans: new Map(),
    logStatuses: new Map(),
    failed: new Set(failed),
    ...over,
  })
  const nodeOf = (t: ReturnType<typeof buildTaskSummary>, key: string) => t.nodes.find((n) => n.key === key)!

  it('jobs 失败 → 基础视频「状态获取失败」，稿件节点仍按真实状态归一', () => {
    const t = buildTaskSummary(copy({ status: 'approved', approvedVersionId: 'v1' }), aggWith(['jobs']))
    const video = nodeOf(t, 'base_video')
    expect(video.statusKey).toBe('error')
    expect(video.statusLabel).toBe('状态获取失败')
    expect(video.actions).toEqual([])
    expect(nodeOf(t, 'copy').statusKey).toBe('approved')
  })

  it('cuts 失败 → 剪辑「状态获取失败」，其余节点正常', () => {
    const t = buildTaskSummary(copy({ status: 'approved', approvedVersionId: 'v1' }), aggWith(['cuts']))
    const edit = nodeOf(t, 'edit')
    expect(edit.statusKey).toBe('error')
    expect(edit.statusLabel).toBe('状态获取失败')
    expect(nodeOf(t, 'base_video').statusKey).not.toBe('error')
    expect(nodeOf(t, 'publish').statusKey).not.toBe('error')
  })

  it('plans 失败 → 发布「状态获取失败」，其余节点正常', () => {
    const t = buildTaskSummary(copy({ status: 'approved', approvedVersionId: 'v1' }), aggWith(['plans']))
    expect(nodeOf(t, 'publish').statusLabel).toBe('状态获取失败')
    expect(nodeOf(t, 'copy').statusKey).toBe('approved')
    expect(nodeOf(t, 'base_video').statusLabel).not.toBe('状态获取失败')
  })

  it('reviews 失败 → 稿件「状态获取失败」，不影响视频与发布节点', () => {
    const t = buildTaskSummary(copy({ status: 'approved', approvedVersionId: 'v1' }), aggWith(['reviews']))
    expect(nodeOf(t, 'copy').statusLabel).toBe('状态获取失败')
    expect(nodeOf(t, 'base_video').statusKey).not.toBe('error')
    expect(nodeOf(t, 'publish').statusKey).not.toBe('error')
  })
})
