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

  console.log(`人物库回归：${passed} 组通过`)
} finally {
  await closeAll()
  rmSync(temp, { recursive: true, force: true })
}
