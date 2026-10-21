/**
 * 人物库纯函数单测（AC-U7 / AC-0.2）：policy.ts §3.2 全部分支 + assets/quality.ts 质检规则。
 * 断言依据是任务书 §3.2 / FR-A1 / FR-A2 / FR-V1，而不是当前实现——规格与实现不符时应当失败。
 */
import { deriveStatus, authorizationEffectiveStatus, isAuthorizationValid, isExpiringSoon, isAvatarUsable, isVoiceUsable, isAssetUsable, normalizeNameKey, type AuthorizationLike, type ExtraStateInput } from '../src/modules/personas/policy.js'
import {
  checkAvatarSourceQuality, checkImageQuality, checkImageStructure, checkJpegStructure, checkPngStructure, checkVideoQuality,
  checkVoiceSampleQuality, checkWebpStructure, isValidIssueCode,
} from '../src/modules/personas/assets/quality.js'
import type { MediaProbe } from '../src/media/inspect.js'
import { toDb } from '../src/lib/time.js'

let passed = 0
let failed = 0
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) passed++
  else {
    failed++
    console.log(`  ❌ ${name}`, extra === undefined ? '' : JSON.stringify(extra).slice(0, 300))
  }
}
function section(title: string): void {
  console.log(`\n[${title}]`)
}

const NOW = new Date('2026-10-21T08:00:00Z')
const DAY = 86_400_000
const at = (offsetMs: number): string => toDb(new Date(NOW.getTime() + offsetMs))
const auth = (id: string, status: string, expiresOffsetMs: number | null, scopes: AuthorizationLike['scopes'] = ['portrait', 'voice']): AuthorizationLike => ({
  id, status, scopes, expiresAt: expiresOffsetMs === null ? null : at(expiresOffsetMs),
})
const extra = (o: Partial<ExtraStateInput> = {}): ExtraStateInput => ({
  avatars: [], voices: [], hasDefaultAvatar: true, hasConfirmedDefaultVoice: true, configured: false, ...o,
})
type Persona = Parameters<typeof deriveStatus>[0]
const kos: Persona = { line: 'kos', enabled: true, archivedAt: null, authRequired: true }
const amateur: Persona = { line: 'persona', enabled: true, archivedAt: null, authRequired: false }
const derive = (p: Persona = kos, auths: AuthorizationLike[] = [], e = extra()) => deriveStatus(p, auths, e, NOW)

section('授权读时派生（FR-U3 / R23）')
check('verified 未到期 → verified', authorizationEffectiveStatus(auth('a', 'verified', DAY), NOW) === 'verified')
check('verified 到期当刻 → expired（<= now）', authorizationEffectiveStatus(auth('a', 'verified', 0), NOW) === 'expired')
check('verified 过期 1ms → expired', authorizationEffectiveStatus(auth('a', 'verified', -1000), NOW) === 'expired')
check('verified 无到期日 → verified', authorizationEffectiveStatus(auth('a', 'verified', null), NOW) === 'verified')
check('revoked 优先于过期', authorizationEffectiveStatus(auth('a', 'revoked', -DAY), NOW) === 'revoked')
check('rejected 保持 rejected', authorizationEffectiveStatus(auth('a', 'rejected', DAY), NOW) === 'rejected')
check('pending 保持 pending（即使日期已过）', authorizationEffectiveStatus(auth('a', 'pending', -DAY), NOW) === 'pending')
check('isAuthorizationValid 仅 verified 未过期', isAuthorizationValid(auth('a', 'verified', DAY), NOW) && !isAuthorizationValid(auth('a', 'pending', DAY), NOW) && !isAuthorizationValid(auth('a', 'verified', -DAY), NOW))
check('30 天内到期 → expiringSoon', isExpiringSoon(auth('a', 'verified', 29 * DAY), NOW))
check('恰 30 天 → expiringSoon（含边界）', isExpiringSoon(auth('a', 'verified', 30 * DAY), NOW))
check('31 天 → 不算将到期', !isExpiringSoon(auth('a', 'verified', 31 * DAY), NOW))
check('已过期不算将到期', !isExpiringSoon(auth('a', 'verified', -DAY), NOW))
check('无到期日不算将到期', !isExpiringSoon(auth('a', 'verified', null), NOW))

section('§3.2 有效状态派生：按顺序取第一个命中')
check('归档 > 停用 > 授权', derive({ ...kos, enabled: false, archivedAt: at(-DAY) }, [auth('a', 'verified', DAY)]).status === 'archived')
check('归档不可用且带原因', (() => { const r = derive({ ...kos, archivedAt: at(-DAY) }); return !r.usable && r.reasons[0]?.code === 'PERSONA_ARCHIVED' })())
check('停用 > 授权状态', derive({ ...kos, enabled: false }, []).status === 'disabled')
check('停用即使授权有效也不可用', !derive({ ...kos, enabled: false }, [auth('a', 'verified', DAY)]).usable)
check('无任何授权 → auth_pending', derive(kos, []).status === 'auth_pending')
check('仅 pending 授权 → auth_pending', derive(kos, [auth('a', 'pending', DAY)]).status === 'auth_pending')
check('仅 rejected 授权 → auth_pending', derive(kos, [auth('a', 'rejected', DAY)]).status === 'auth_pending')
check('仅 verified 已过期 → auth_expired', derive(kos, [auth('a', 'verified', -DAY)]).status === 'auth_expired')
check('仅被撤销 → auth_revoked', derive(kos, [auth('a', 'revoked', DAY)]).status === 'auth_revoked', derive(kos, [auth('a', 'revoked', DAY)]).status)
check('撤销优于过期（AC-U7）', derive(kos, [auth('a', 'revoked', DAY), auth('b', 'verified', -DAY)]).status === 'auth_revoked', derive(kos, [auth('a', 'revoked', DAY), auth('b', 'verified', -DAY)]).status)
check('撤销一份但另有有效授权 → active', derive(kos, [auth('a', 'revoked', DAY), auth('b', 'verified', DAY)]).status === 'active')
check('多条授权取有效者：过期 + 有效 → active', derive(kos, [auth('a', 'verified', -DAY), auth('b', 'verified', DAY)]).usable)
check('多条授权：过期 + 待核验 → auth_expired 优先于 pending', derive(kos, [auth('a', 'verified', -DAY), auth('b', 'pending', DAY)]).status === 'auth_expired')
check('有效授权 → active 且 usable', (() => { const r = derive(kos, [auth('a', 'verified', DAY)]); return r.status === 'active' && r.usable && r.reasons.length === 0 })())
check('不可用原因文案非空', ['auth_pending', 'auth_expired', 'auth_revoked'].every((s) => {
  const auths = s === 'auth_pending' ? [] : s === 'auth_expired' ? [auth('a', 'verified', -DAY)] : [auth('a', 'revoked', DAY)]
  return derive(kos, auths).reasons.every((r) => r.code && r.message)
}))
check('素人线无授权也 active（AC-U6）', derive(amateur, []).status === 'active' && derive(amateur, []).usable)
check('素人线授权过期仍 active（不强制）', derive(amateur, [auth('a', 'verified', -DAY)]).usable)
check('素人线停用仍不可用', !derive({ ...amateur, enabled: false }, []).usable)
check('素人线归档不可用', derive({ ...amateur, archivedAt: at(-DAY) }, []).status === 'archived')

section('授权范围与有效授权 id')
{
  const r = derive(kos, [auth('p', 'verified', DAY, ['portrait']), auth('v', 'verified', DAY, ['voice']), auth('s', 'verified', DAY, ['portrait', 'voice', 'share']), auth('old', 'verified', -DAY, ['portrait', 'voice', 'share'])])
  check('肖像有效授权不含过期 / 非肖像', r.validPortraitAuthIds.sort().join() === 'p,s', r.validPortraitAuthIds)
  check('声音有效授权', r.validVoiceAuthIds.sort().join() === 's,v', r.validVoiceAuthIds)
  check('共享有效授权只含带 share 且有效的', r.validShareAuthIds.join() === 's', r.validShareAuthIds)
}

section('附加标签（不影响 usable）')
{
  const ok = [auth('a', 'verified', 90 * DAY)]
  check('已配置', derive(kos, ok, extra({ configured: true })).extraTags.includes('configured'))
  check('声音待确认', derive(kos, ok, extra({ voices: [{ status: 'ready', confirmed: false, deletedAt: null }] })).extraTags.includes('voice_unconfirmed'))
  check('已删除的未确认声音不计', !derive(kos, ok, extra({ voices: [{ status: 'ready', confirmed: false, deletedAt: at(-1) }] })).extraTags.includes('voice_unconfirmed'))
  check('制作中（pending / submitting / running）', ['pending', 'submitting', 'running'].every((s) => derive(kos, ok, extra({ avatars: [{ status: s, deletedAt: null }] })).extraTags.includes('avatar_in_progress')))
  check('ready 不算制作中', !derive(kos, ok, extra({ avatars: [{ status: 'ready', deletedAt: null }] })).extraTags.includes('avatar_in_progress'))
  check('状态待核对（分身或声音 uncertain）', derive(kos, ok, extra({ voices: [{ status: 'uncertain', confirmed: false, deletedAt: null }] })).extraTags.includes('uncertain'))
  check('已删除的 uncertain 不计', !derive(kos, ok, extra({ avatars: [{ status: 'uncertain', deletedAt: at(-1) }] })).extraTags.includes('uncertain'))
  check('授权将到期', derive(kos, [auth('a', 'verified', 10 * DAY)], extra()).extraTags.includes('auth_expiring'))
  check('授权充裕不提示', !derive(kos, ok, extra()).extraTags.includes('auth_expiring'))
  check('待完善：缺默认分身', derive(kos, ok, extra({ hasDefaultAvatar: false })).extraTags.includes('incomplete'))
  check('待完善：缺已确认默认声音', derive(kos, ok, extra({ hasConfirmedDefaultVoice: false })).extraTags.includes('incomplete'))
  check('素人线不出现「待完善」', !derive(amateur, [], extra({ hasDefaultAvatar: false, hasConfirmedDefaultVoice: false })).extraTags.includes('incomplete'))
  check('附加标签不改变 usable', derive(kos, ok, extra({ hasDefaultAvatar: false, voices: [{ status: 'uncertain', confirmed: false, deletedAt: null }] })).usable)
}

section('资产可用性（§3.2 末段）')
check('照片 / 背景：approved 且未删', isAssetUsable('approved', null) && !isAssetUsable('pending_review', null) && !isAssetUsable('approved', at(-1)) && !isAssetUsable('rejected', null))
check('分身：ready + 未删 + 肖像授权有效', isAvatarUsable({ status: 'ready', deletedAt: null, authorizationId: 'p' }, ['p']))
check('分身：授权失效不可用', !isAvatarUsable({ status: 'ready', deletedAt: null, authorizationId: 'x' }, ['p']))
check('分身：非 ready / 已删不可用', !isAvatarUsable({ status: 'running', deletedAt: null, authorizationId: 'p' }, ['p']) && !isAvatarUsable({ status: 'ready', deletedAt: at(-1), authorizationId: 'p' }, ['p']))
check('声音：ready + 已确认 + 授权有效', isVoiceUsable({ status: 'ready', confirmed: true, deletedAt: null, authorizationId: 'v' }, ['v']))
check('声音：未确认不可用', !isVoiceUsable({ status: 'ready', confirmed: false, deletedAt: null, authorizationId: 'v' }, ['v']))
check('声音：共享人物需「允许共享」', !isVoiceUsable({ status: 'ready', confirmed: true, deletedAt: null, authorizationId: 'v' }, ['v'], { requireShare: true, shareAuthIds: [] })
  && isVoiceUsable({ status: 'ready', confirmed: true, deletedAt: null, authorizationId: 'v' }, ['v'], { requireShare: true, shareAuthIds: ['v'] }))
check('声音：授权失效 / 已删不可用', !isVoiceUsable({ status: 'ready', confirmed: true, deletedAt: null, authorizationId: 'x' }, ['v']) && !isVoiceUsable({ status: 'ready', confirmed: true, deletedAt: at(-1), authorizationId: 'v' }, ['v']))

section('名称规范化（FR-L2）')
check('忽略首尾空白', normalizeNameKey('  张三 ') === normalizeNameKey('张三'))
check('全角与半角等价', normalizeNameKey('ＡＢＣ１２３') === normalizeNameKey('abc123'))
check('大小写不敏感', normalizeNameKey('Wang') === normalizeNameKey('wANG'))
check('内部连续空白折叠', normalizeNameKey('老  周') === normalizeNameKey('老 周'))
check('不同名称不相等', normalizeNameKey('张三') !== normalizeNameKey('张四'))
check('空值安全', normalizeNameKey(undefined as unknown as string) === '')

section('图片结构校验（R27）')
{
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(300, 1), Buffer.from([0xff, 0xd9])])
  check('完整 JPEG 通过', checkJpegStructure(jpeg) === null)
  check('JPEG 末尾带少量填充仍通过', checkJpegStructure(Buffer.concat([jpeg, Buffer.alloc(8)])) === null)
  check('截断 JPEG（缺 FFD9）→ IMG_TRUNCATED', checkJpegStructure(jpeg.subarray(0, 200))?.code === 'IMG_TRUNCATED')
  check('过小文件 → IMG_TRUNCATED', checkJpegStructure(Buffer.alloc(20))?.code === 'IMG_TRUNCATED')
  check('JPEG 头不符 → IMG_BAD_HEADER', checkJpegStructure(Buffer.concat([Buffer.from([0x00, 0x00]), Buffer.alloc(300, 1), Buffer.from([0xff, 0xd9])]))?.code === 'IMG_BAD_HEADER')
  const png = Buffer.concat([Buffer.alloc(100, 2), Buffer.from('IEND'), Buffer.alloc(4)])
  check('PNG 含 IEND 通过', checkPngStructure(png) === null)
  check('PNG 缺 IEND → IMG_TRUNCATED', checkPngStructure(Buffer.alloc(200, 2))?.code === 'IMG_TRUNCATED')
  const webp = Buffer.alloc(40)
  webp.write('RIFF', 0)
  webp.writeUInt32LE(32, 4)
  check('WebP 声明长度与实际一致通过', checkWebpStructure(webp) === null)
  const bad = Buffer.from(webp)
  bad.writeUInt32LE(5000, 4)
  check('WebP 声明长度大于实际 → IMG_TRUNCATED', checkWebpStructure(bad)?.code === 'IMG_TRUNCATED')
  check('按扩展名分派', checkImageStructure('.png', Buffer.alloc(200))?.code === 'IMG_TRUNCATED' && checkImageStructure('.jpg', jpeg) === null && checkImageStructure('.webp', webp) === null)
}

section('照片质检（FR-A1）：最短边 ≥720')
check('720 通过', checkImageQuality({ width: 720, height: 1280 }).pass)
check('719 → 硬性失败 IMG_TOO_SMALL', (() => { const r = checkImageQuality({ width: 719, height: 1280 }); return !r.pass && r.hard[0]?.code === 'IMG_TOO_SMALL' })())
check('以短边为准（横图）', !checkImageQuality({ width: 1920, height: 600 }).pass && checkImageQuality({ width: 1920, height: 720 }).pass)
check('<400 仅软提示且硬性失败', (() => { const r = checkImageQuality({ width: 300, height: 300 }); return r.soft[0]?.code === 'IMG_LOW_RES' && !r.pass })())
check('大图无软提示', checkImageQuality({ width: 1080, height: 1920 }).soft.length === 0)

section('分身素材质检（FR-A2）')
const probe = (o: Partial<MediaProbe> = {}): MediaProbe => ({
  kind: 'video', durationMs: 30_000, width: 1080, height: 1920, fps: 30, hasVideo: true, hasAudio: true, format: 'mov,mp4', sizeBytes: 1_000_000, ...o,
})
check('合法竖屏通过', checkAvatarSourceQuality(probe()).pass)
check('无视频流 → VID_NO_STREAM', checkAvatarSourceQuality(probe({ hasVideo: false })).hard.some((i) => i.code === 'VID_NO_STREAM'))
check('9.9 秒 → VID_TOO_SHORT', checkAvatarSourceQuality(probe({ durationMs: 9_900 })).hard.some((i) => i.code === 'VID_TOO_SHORT'))
check('恰 10 秒通过（下限含边界）', checkAvatarSourceQuality(probe({ durationMs: 10_000 })).pass)
check('恰 10 分钟通过', checkAvatarSourceQuality(probe({ durationMs: 600_000 })).pass)
check('超 10 分钟 → VID_TOO_LONG', checkAvatarSourceQuality(probe({ durationMs: 600_001 })).hard.some((i) => i.code === 'VID_TOO_LONG'))
check('短边 719 → VID_TOO_SMALL', checkAvatarSourceQuality(probe({ width: 719, height: 1280 })).hard.some((i) => i.code === 'VID_TOO_SMALL'))
check('横屏仅软提示（仍通过）', (() => { const r = checkAvatarSourceQuality(probe({ width: 1920, height: 1080 })); return r.pass && r.soft.some((i) => i.code === 'VID_NOT_PORTRAIT') })())
check('9:16 容差内无横屏提示', checkAvatarSourceQuality(probe({ width: 1080, height: 1920 })).soft.every((i) => i.code !== 'VID_NOT_PORTRAIT'))
check('帧率 <24 软提示', checkAvatarSourceQuality(probe({ fps: 23 })).soft.some((i) => i.code === 'VID_LOW_FPS'))
check('帧率 24 无提示', checkAvatarSourceQuality(probe({ fps: 24 })).soft.every((i) => i.code !== 'VID_LOW_FPS'))
check('时长缺失按 0 处理 → 不通过', !checkAvatarSourceQuality(probe({ durationMs: null })).pass)

section('背景 / 空镜视频与声音样本质检')
check('背景视频 ≤60 秒通过', checkVideoQuality(probe({ durationMs: 60_000 })).pass)
check('背景视频 >60 秒失败', checkVideoQuality(probe({ durationMs: 60_001 })).hard.some((i) => i.code === 'VID_TOO_LONG'))
check('背景视频无视频流失败', !checkVideoQuality(probe({ hasVideo: false })).pass)
const audio = (ms: number | null, hasAudio = true): MediaProbe => probe({ kind: 'audio', hasVideo: false, hasAudio, durationMs: ms, width: null, height: null, fps: null })
check('样本 4.9 秒 → AUD_TOO_SHORT', checkVoiceSampleQuality(audio(4_900)).hard.some((i) => i.code === 'AUD_TOO_SHORT'))
check('样本 5 秒通过', checkVoiceSampleQuality(audio(5_000)).pass)
check('样本 180 秒通过', checkVoiceSampleQuality(audio(180_000)).pass)
check('样本 180.1 秒 → AUD_TOO_LONG', checkVoiceSampleQuality(audio(180_100)).hard.some((i) => i.code === 'AUD_TOO_LONG'))
check('样本无音频流 → AUD_NO_STREAM', checkVoiceSampleQuality(audio(30_000, false)).hard.some((i) => i.code === 'AUD_NO_STREAM'))

section('issue code 规范（R28）')
check('合法', ['IMG_TOO_SMALL', 'AB', 'A1_B2'].every(isValidIssueCode))
check('非法', ['', 'a', 'img_small', '1ABC', 'A', 'A-B', 'X'.repeat(65)].every((c) => !isValidIssueCode(c)))

console.log(`\n=== 人物库纯函数单测：${passed} 通过，${failed} 失败 ===`)
process.exit(failed ? 1 : 0)
