/**
 * 人物库回归（临时 SQLite + 真实迁移 + 内存队列 + 飞影 mock）。
 * 用法：node --import tsx scripts/test-persona-regressions.ts
 *
 * 覆盖 2026-10-22 代码审查发现：
 *  1. 版本快照必须带上 IP 定位内容（此前少了 await，快照里的定位恒为空）；
 *  2. 失败 / 过期的任意文本试听可以重新生成（此前 upsert 冲突后用了未落库的新 id → 500）；
 *  3. 试听轮询超过上限转失败，不再无限重排。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const temp = mkdtempSync(join(tmpdir(), 'koubo-persona-'))
process.env.DB_DRIVER = 'sqlite'
process.env.DB_SQLITE_PATH = join(temp, 'test.db')
process.env.TEMP_DIR = join(temp, 'media')
process.env.HIFLY_API_KEY = ''
process.env.MOCK_FALLBACK = 'true'
process.env.LOG_LEVEL = 'silent'

const { initDb, closeAll } = await import('../src/db/index.js')
const { runMigrations } = await import('../src/db/migrate.js')
const { setQueueBackend } = await import('../src/queue/index.js')
const { createPersona, saveProfile, getPersonaById } = await import('../src/modules/personas/repo.js')
const { buildSnapshot } = await import('../src/modules/personas/versions.js')
const { createVoicePreview, getVoicePreview } = await import('../src/modules/personas/clone/voices.js')
const { pollPreview } = await import('../src/modules/personas/clone/worker.js')
const { getProductionProfile } = await import('../src/modules/personas/readiness.js')
const { ensurePersonaVersion } = await import('../src/modules/personas/versions.js')
const { config } = await import('../src/config.js')

setQueueBackend('memory')
const db = await initDb()
let passed = 0
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  await fn()
  passed++
  console.log(`PASS ${name}`)
}

/** 直接落一条 ready 的克隆声音（绕过克隆流程，只为试听前置条件） */
async function insertReadyVoice(personaId: string): Promise<string> {
  const id = `pvc_test_${Math.random().toString(36).slice(2, 10)}`
  await db.run(
    `INSERT INTO \`persona_voice\` (\`id\`, \`persona_id\`, \`name\`, \`is_sample\`, \`sample_key\`, \`sample_sha256\`,
      \`vendor_title\`, \`short_ref\`, \`vendor_voice_id\`, \`consent_id\`, \`authorization_id\`, \`status\`, \`confirmed\`,
      \`idempotency_key\`, \`request_hash\`)
     VALUES (?, ?, ?, 0, 'k', 's', 't', ?, 'mock_voice_x', 'c', 'a', 'ready', 1, ?, 'h')`,
    [id, personaId, '测试声音', id.slice(-6), id],
  )
  return id
}

try {
  await runMigrations(db)
  const persona = await createPersona({ name: '回归测试人物', line: 'kos', operator: 'test' })

  await test('版本快照包含 IP 定位内容', async () => {
    await saveProfile(persona.id, { role: '投资顾问', forbiddenClaims: ['不承诺收益'] }, undefined, 'test')
    const fresh = (await getPersonaById(persona.id, true))!
    const snapshot = await buildSnapshot(fresh)
    const profile = snapshot.ipProfile as { role?: string; forbiddenClaims?: string[] }
    assert.equal(profile.role, '投资顾问')
    assert.deepEqual(profile.forbiddenClaims, ['不承诺收益'])
  })

  await test('失败的试听可以重新生成，并复用原记录', async () => {
    const voiceId = await insertReadyVoice(persona.id)
    const first = await createVoicePreview(voiceId, '大家好，今天聊定投。', 'test')
    await db.run('UPDATE `persona_voice_preview` SET `status` = ?, `error` = ? WHERE `id` = ?', ['failed', 'x', first.preview.id])
    const retry = await createVoicePreview(voiceId, '大家好，今天聊定投。', 'test')
    assert.equal(retry.cached, false)
    assert.equal(retry.preview.id, first.preview.id)
    assert.equal(retry.preview.status, 'running')
    assert.equal(retry.preview.error, null)
  })

  await test('试听轮询超过时长上限转失败，不再无限重排', async () => {
    const voiceId = await insertReadyVoice(persona.id)
    const r = await createVoicePreview(voiceId, '超时用例', 'test')
    const old = new Date(Date.now() - config.hifly.pollMaxAgeMs - 60_000)
    // 飞影 mock 不认识的任务号：查询必抛错，原逻辑会一直重排
    await db.run('UPDATE `persona_voice_preview` SET `vendor_task_id` = ?, `created_at` = ? WHERE `id` = ?', [
      'task_unknown',
      old.toISOString().slice(0, 19).replace('T', ' '),
      r.preview.id,
    ])
    await pollPreview(r.preview.id)
    const after = await getVoicePreview(r.preview.id)
    assert.equal(after?.status, 'failed')
    assert.match(after?.error ?? '', /超时/)
  })

  await test('mixcut 取用：只有就绪声音、无分身也能取到 production-profile', async () => {
    // 种一条有效授权（portrait + voice），与 insertReadyVoice 硬编码的 authorization_id='a' 对齐
    await db.run(
      `INSERT INTO \`persona_authorization\` (\`id\`, \`persona_id\`, \`grantor_name\`, \`scopes\`, \`file_key\`,
        \`file_mime\`, \`file_size\`, \`file_sha256\`, \`expires_at\`, \`status\`, \`verified_by\`, \`verified_at\`, \`created_by\`)
       VALUES ('a', ?, '测试授权人', '["portrait","voice"]', 'seed/a.pdf', 'application/pdf', 0, '${'0'.repeat(64)}',
        '2099-12-31 23:59:59', 'verified', 'test', '${new Date().toISOString().slice(0, 19).replace('T', ' ')}', 'test')`,
      [persona.id],
    )
    await insertReadyVoice(persona.id)
    // 先设为默认声音，readiness/production-profile 只看 default_voice_id；版本由路由层保存定位后创建，这里对齐生产行为
    await db.run('UPDATE `persona` SET `default_voice_id` = ? WHERE `id` = ?', [
      (await db.get<{ id: string }>('SELECT `id` FROM `persona_voice` WHERE `persona_id` = ?', [persona.id]))!.id,
      persona.id,
    ])
    await ensurePersonaVersion((await getPersonaById(persona.id, true))!, 'profile', 'test')
    const profile = await getProductionProfile(persona.id, { purpose: 'mixcut' })
    assert.equal(profile.purpose, 'mixcut')
    assert.equal(profile.avatar, null)
    assert.equal(profile.voice?.vendorVoiceId, 'mock_voice_x')
    assert.ok(profile.versionId, 'mixcut 也应携带版本 id 供任务冻结')
  })

  await test('mixcut 取用：素人无克隆声音时 voice 为空（M3 用公共音色兜底）', async () => {
    const lay = await createPersona({ name: '素人混剪人物', line: 'persona', operator: 'test' })
    const profile = await getProductionProfile(lay.id, { purpose: 'mixcut' })
    assert.equal(profile.purpose, 'mixcut')
    assert.equal(profile.voice, null)
    assert.equal(profile.avatar, null)
  })

  await test('mixcut 取用：经理线无克隆声音仍被拒（数字人口播必须本人声音）', async () => {
    const mgr = await createPersona({ name: '经理混剪人物', line: 'manager', operator: 'test' })
    await assert.rejects(() => getProductionProfile(mgr.id, { purpose: 'mixcut' }), /声音/)
  })

  await test('avatar_video 取用仍要求默认分身就绪（回归守卫）', async () => {
    await assert.rejects(() => getProductionProfile(persona.id), /未准备就绪/)
  })

  console.log(`人物库回归：${passed} 组通过`)
} finally {
  await closeAll()
  rmSync(temp, { recursive: true, force: true })
}
// 成功才会执行到这里；事件循环上有残留句柄（内存队列轮询），不显式退出进程会挂住
process.exit(0)
