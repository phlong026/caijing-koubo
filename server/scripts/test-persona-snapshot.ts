/**
 * 人物版本快照 hash 单测（§3.4 / L7）。
 * 用法：node --import tsx scripts/test-persona-snapshot.ts
 *
 * 版本是否新建完全取决于 snapshotHash：嵌套字段（声音参数、飞影标识、IP 定位内容）
 * 变化必须改变 hash；键顺序不同不能改变 hash。
 */
import assert from 'node:assert/strict'
import { snapshotHash } from '../src/modules/personas/versions.js'
import { profileHash } from '../src/modules/personas/profile.js'
import type { IpProfile } from '../src/modules/personas/repo.js'

let passed = 0
function test(name: string, fn: () => void): void {
  fn()
  passed++
  console.log(`  ✅ ${name}`)
}

const base = {
  personaId: 'ps_1',
  name: '测试',
  defaultVoice: { id: 'pvc_1', vendorVoiceId: 'v1', speechRate: 1, volume: 1, pitch: 1 },
  defaultAvatar: { id: 'pav_1', vendorAvatarId: 'a1', backgroundLabel: '白色' },
  ipProfile: { role: '投资顾问', forbiddenClaims: ['不承诺收益'] },
}

test('嵌套的声音参数变化改变 hash', () => {
  const changed = { ...base, defaultVoice: { ...base.defaultVoice, speechRate: 1.4 } }
  assert.notEqual(snapshotHash(changed), snapshotHash(base))
})

test('嵌套的飞影分身标识变化改变 hash', () => {
  const changed = { ...base, defaultAvatar: { ...base.defaultAvatar, vendorAvatarId: 'a2' } }
  assert.notEqual(snapshotHash(changed), snapshotHash(base))
})

test('IP 定位内容变化改变 hash', () => {
  const changed = { ...base, ipProfile: { ...base.ipProfile, role: '基金经理' } }
  assert.notEqual(snapshotHash(changed), snapshotHash(base))
})

test('键顺序不同（含嵌套）不改变 hash', () => {
  const reordered = {
    ipProfile: { forbiddenClaims: ['不承诺收益'], role: '投资顾问' },
    defaultAvatar: { backgroundLabel: '白色', vendorAvatarId: 'a1', id: 'pav_1' },
    defaultVoice: { pitch: 1, volume: 1, speechRate: 1, vendorVoiceId: 'v1', id: 'pvc_1' },
    name: '测试',
    personaId: 'ps_1',
  }
  assert.equal(snapshotHash(reordered), snapshotHash(base))
})

test('数组顺序有意义（禁用表达顺序变化视为变化）', () => {
  const a = { ...base, ipProfile: { ...base.ipProfile, forbiddenClaims: ['甲', '乙'] } }
  const b = { ...base, ipProfile: { ...base.ipProfile, forbiddenClaims: ['乙', '甲'] } }
  assert.notEqual(snapshotHash(a), snapshotHash(b))
})

const profile: IpProfile = {
  role: '投资顾问',
  serviceScope: '',
  targetAudience: '',
  expressionStyle: '',
  forbiddenClaims: [],
  contentMix: [{ label: '知识科普', ratio: 60 }, { label: '市场解读', ratio: 40 }],
}

test('IP 定位：内容配比比例变化改变 hash（否则不升版本）', () => {
  const changed = { ...profile, contentMix: [{ label: '知识科普', ratio: 50 }, { label: '市场解读', ratio: 50 }] }
  assert.notEqual(profileHash(changed), profileHash(profile))
})

test('IP 定位：内容配比标签变化改变 hash', () => {
  const changed = { ...profile, contentMix: [{ label: '风险提示', ratio: 60 }, { label: '市场解读', ratio: 40 }] }
  assert.notEqual(profileHash(changed), profileHash(profile))
})

console.log(`人物快照 / 定位 hash：${passed} 项通过`)
