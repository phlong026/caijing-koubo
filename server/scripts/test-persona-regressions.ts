/**
 * 人物库回归（SQLite + mock，无需起服务）：覆盖评审报告中的人物库缺陷。
 * 用法：npm run test:personas
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const temp = mkdtempSync(join(tmpdir(), 'koubo-persona-'))
process.env.DB_DRIVER = 'sqlite'
process.env.DB_SQLITE_PATH = join(temp, 'test.db')
process.env.MOCK_FALLBACK = 'true'
process.env.LOG_LEVEL = 'silent'
const { initDb, closeAll } = await import('../src/db/index.js')
const { runMigrations } = await import('../src/db/migrate.js')
const { createPersona, getPersonaById, updatePersona, archivePersona } = await import('../src/modules/personas/repo.js')
const { getProductionProfile, checkReadiness } = await import('../src/modules/personas/readiness.js')
const { cleanExpiredPreviews } = await import('../src/modules/personas/clone/voices.js')
const { sweepDuePolls } = await import('../src/modules/personas/clone/worker.js')
const { memQueueStats } = await import('../src/queue/memory.js')
const { paths } = await import('../src/config.js')
const { deriveStatus } = await import('../src/modules/personas/policy.js')
const { toDb, utcNow } = await import('../src/lib/time.js')
const { uploadAsset, setCoverAsset } = await import('../src/modules/personas/assets.js')
const { config } = await import('../src/config.js')
const { scanAuthExpiry, uploadAuthorization } = await import('../src/modules/personas/authorizations.js')
const db = await initDb()
// 用进程内队列：不能把任务投进本机 Redis（会被正在运行的开发实例消费）
const { setQueueBackend, closeQueues, redis } = await import('../src/queue/index.js')
setQueueBackend('memory')

let passed = 0
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  await fn()
  passed++
  console.log(`PASS ${name}`)
}

let seq = 0
const uid = (p: string) => `${p}_${(++seq).toString().padStart(4, '0')}`

/** 造一个「可用于数字人口播」的人物：已核验授权 + ready 默认分身 + 已确认默认声音 */
async function readyPersona(name: string, opts: { scopes?: string[]; line?: 'manager' | 'kos' } = {}) {
  const p = await createPersona({ name, line: opts.line ?? 'manager', operator: 'test' })
  const now = toDb(utcNow())
  const authId = uid('auth')
  await db.run(
    `INSERT INTO persona_authorization (id, persona_id, grantor_name, scopes, file_key, file_mime, file_size, file_sha256,
       effective_from, expires_at, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'k', 'application/pdf', 1, 'x', '2026-01-01', '2099-12-31 23:59:59', 'verified', 'test', ?, ?)`,
    [authId, p.id, name, JSON.stringify(opts.scopes ?? ['portrait', 'voice']), now, now],
  )
  const avatarId = uid('pav')
  await db.run(
    `INSERT INTO persona_avatar (id, persona_id, name, source_asset_id, source_kind, vendor_title, short_ref, vendor_avatar_id,
       status, consent_id, authorization_id, idempotency_key, request_hash, created_at, updated_at)
     VALUES (?, ?, ?, 'asset', 'video', 't', ?, ?, 'ready', 'c', ?, ?, 'h', ?, ?)`,
    [avatarId, p.id, `${name}分身`, avatarId.slice(-6), `vendor_${avatarId}`, authId, avatarId, now, now],
  )
  const voiceId = uid('pvc')
  await db.run(
    `INSERT INTO persona_voice (id, persona_id, name, is_sample, sample_key, sample_sha256, vendor_title, short_ref, vendor_voice_id,
       consent_id, authorization_id, status, confirmed, idempotency_key, request_hash, created_at, updated_at)
     VALUES (?, ?, ?, 0, 'k', 'x', 't', ?, ?, 'c', ?, 'ready', 1, ?, 'h', ?, ?)`,
    [voiceId, p.id, `${name}声音`, voiceId.slice(-6), `vendor_${voiceId}`, authId, voiceId, now, now],
  )
  await db.run('UPDATE persona SET default_avatar_id = ?, default_voice_id = ? WHERE id = ?', [avatarId, voiceId, p.id])
  return { personaId: p.id, authId, avatarId, voiceId }
}

try {
  await runMigrations(db)
  const a = await readyPersona('回归甲')
  const b = await readyPersona('回归乙')

  await test('P1-4 production-profile 不能借用其他人物的分身', async () => {
    const own = await getProductionProfile(b.personaId)
    assert.equal(own.avatar.avatarId, b.avatarId)
    await assert.rejects(getProductionProfile(b.personaId, a.avatarId), (e: any) => e?.code === 'PERSONA_NOT_READY')
  })

  await test('P1-4 指定非默认分身：按人物任一有效肖像授权判定，授权全部失效时被拒', async () => {
    const now = toDb(utcNow())
    const expiredAuth = uid('auth')
    await db.run(
      `INSERT INTO persona_authorization (id, persona_id, grantor_name, scopes, file_key, file_mime, file_size, file_sha256,
         effective_from, expires_at, status, created_by, created_at, updated_at)
       VALUES (?, ?, 'x', '["portrait"]', 'k', 'application/pdf', 1, 'x', '2020-01-01', '2021-01-01 23:59:59', 'verified', 'test', ?, ?)`,
      [expiredAuth, a.personaId, now, now],
    )
    const second = uid('pav')
    await db.run(
      `INSERT INTO persona_avatar (id, persona_id, name, source_asset_id, source_kind, vendor_title, short_ref, vendor_avatar_id,
         status, consent_id, authorization_id, idempotency_key, request_hash, created_at, updated_at)
       VALUES (?, ?, '旧授权分身', 'asset', 'video', 't', ?, 'vendor_x', 'ready', 'c', ?, ?, 'h', ?, ?)`,
      [second, a.personaId, second.slice(-6), expiredAuth, second, now, now],
    )
    // 旧分身绑定的授权已过期，但人物另有有效肖像授权（场景 3：补授权后旧分身无需重建）
    const viaOther = await getProductionProfile(a.personaId, second)
    assert.equal(viaOther.avatar.avatarId, second)
    // 人物的有效授权被撤销后，任何分身都不能用于视频生成
    await db.run("UPDATE persona_authorization SET status = 'revoked' WHERE persona_id = ? AND id <> ?", [a.personaId, expiredAuth])
    await assert.rejects(getProductionProfile(a.personaId, second), (e: any) => e?.code === 'PERSONA_NOT_READY')
    await assert.rejects(getProductionProfile(a.personaId), (e: any) => e?.code === 'PERSONA_NOT_READY')
    assert.ok(await getPersonaById(a.personaId, true))
  })

  await test('P1-5 §3.2 状态派生：撤销 > 过期 > 待核验，有效授权优先', () => {
    const persona = { line: 'manager' as const, enabled: true, archivedAt: null, authRequired: true }
    const extra = { avatars: [], voices: [], hasDefaultAvatar: false, hasConfirmedDefaultVoice: false, configured: false }
    const auth = (status: string, expiresAt = '2099-01-01 00:00:00') => ({ id: uid('a'), status, scopes: ['portrait' as const], expiresAt })
    const statusOf = (auths: ReturnType<typeof auth>[]) => deriveStatus(persona, auths, extra).status
    assert.equal(statusOf([auth('revoked')]), 'auth_revoked')
    assert.equal(deriveStatus(persona, [auth('revoked')], extra).reasons[0]?.code, 'AUTH_REVOKED')
    assert.equal(statusOf([auth('revoked'), auth('verified', '2020-01-01 00:00:00')]), 'auth_revoked')
    assert.equal(statusOf([auth('verified', '2020-01-01 00:00:00'), auth('pending')]), 'auth_expired')
    assert.equal(statusOf([auth('pending')]), 'auth_pending')
    assert.equal(statusOf([auth('rejected')]), 'auth_pending')
    assert.equal(statusOf([]), 'auth_pending')
    assert.equal(statusOf([auth('revoked'), auth('verified')]), 'active')
    assert.equal(deriveStatus({ ...persona, enabled: false }, [auth('verified')], extra).status, 'disabled')
    assert.equal(deriveStatus({ ...persona, archivedAt: '2026-01-01' }, [auth('verified')], extra).status, 'archived')
    assert.equal(deriveStatus({ ...persona, line: 'persona', authRequired: false }, [], extra).status, 'active')
  })

  await test('P2-1 改为共享前须有「允许共享」声音授权；readiness 校验共享授权', async () => {
    const k = await readyPersona('回归丙', { line: 'kos', scopes: ['portrait', 'voice'] })
    const p0 = (await getPersonaById(k.personaId, true))!
    // createPersona 对 KOS 缺省共享；先切到一对一再验证切回共享被拒
    const exclusive = p0.bindingMode === 'shared' ? await updatePersona(k.personaId, { bindingMode: 'exclusive', rev: p0.rev, operator: 't' }) : p0
    await assert.rejects(
      updatePersona(k.personaId, { bindingMode: 'shared', rev: exclusive.rev, operator: 't' }),
      (e: any) => e?.code === 'PERSONA_BINDING_RULE',
    )
    await db.run("UPDATE persona_authorization SET scopes = ? WHERE id = ?", [JSON.stringify(['portrait', 'voice', 'share']), k.authId])
    const shared = await updatePersona(k.personaId, { bindingMode: 'shared', rev: exclusive.rev, operator: 't' })
    assert.equal(shared.bindingMode, 'shared')
    assert.equal((await checkReadiness(k.personaId, 'avatar_video')).pass, true)
    await db.run("UPDATE persona_authorization SET scopes = ? WHERE id = ?", [JSON.stringify(['portrait', 'voice']), k.authId])
    const r = await checkReadiness(k.personaId, 'avatar_video')
    assert.equal(r.pass, false)
    assert.equal(r.checks.find((c) => c.key === 'voice_share_auth')?.pass, false)
  })

  await test('P2-1 绑定多个账号时不能改回一对一', async () => {
    const k = await readyPersona('回归丁', { line: 'kos', scopes: ['portrait', 'voice', 'share'] })
    const now = toDb(utcNow())
    for (const key of ['acc1', 'acc2']) {
      await db.run(
        'INSERT INTO persona_account_binding (id, persona_id, platform, account_key, display_name, created_at, active_key) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [uid('bind'), k.personaId, 'douyin', `${k.personaId}-${key}`, key, now, `douyin:${k.personaId}-${key}`],
      )
    }
    const p = (await getPersonaById(k.personaId, true))!
    assert.equal(p.bindingMode, 'shared')
    await assert.rejects(
      updatePersona(k.personaId, { bindingMode: 'exclusive', rev: p.rev, operator: 't' }),
      (e: any) => e?.code === 'PERSONA_BINDING_RULE',
    )
  })

  await test('P2-3 存储失败不留坏记录；处理失败的同文件可重新上传', async () => {
    const p = await createPersona({ name: '回归戊', line: 'kos', operator: 'test' })
    const img = join(temp, 'bg.jpg')
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=1', '-frames:v', '1', img])
    const head = Buffer.alloc(16)
    const fd = await import('node:fs').then((m) => m.openSync(img, 'r'))
    ;(await import('node:fs')).readSync(fd, head, 0, 16, 0)
    const input = { personaId: p.id, kind: 'background_image' as const, filePath: img, filename: 'bg.jpg', size: statSync(img).size, head, operator: 'test' }
    config.mockFallback = false // 无 OSS 且关闭兜底 → 存储写入失败
    await assert.rejects(uploadAsset(input), (e: any) => e?.code === 'upstream_error')
    config.mockFallback = true
    const left = await db.get<{ c: number }>('SELECT COUNT(*) AS c FROM persona_asset WHERE persona_id = ?', [p.id])
    assert.equal(Number(left?.c), 0)
    const first = await uploadAsset(input)
    assert.equal(first.deduplicated, false)
    assert.equal((await uploadAsset(input)).deduplicated, true)
    await db.run("UPDATE persona_asset SET status = 'failed' WHERE id = ?", [first.asset.id])
    const again = await uploadAsset(input)
    assert.equal(again.deduplicated, false)
    assert.notEqual(again.asset.id, first.asset.id)
    const old = await db.get<{ deleted_at: string | null }>('SELECT deleted_at FROM persona_asset WHERE id = ?', [first.asset.id])
    assert.ok(old?.deleted_at)
  })

  await test('P2-5 归档人物不能再设置封面', async () => {
    const p = await createPersona({ name: '回归己', line: 'kos', operator: 'test' })
    const now = toDb(utcNow())
    const photo = uid('pa')
    await db.run(
      `INSERT INTO persona_asset (id, persona_id, kind, name, status, storage_key, mime, size_bytes, sha256, created_at, updated_at)
       VALUES (?, ?, 'photo', '照片', 'approved', 'k', 'image/jpeg', 1, 'x', ?, ?)`,
      [photo, p.id, now, now],
    )
    await setCoverAsset(p.id, photo, 'test')
    await archivePersona(p.id, 'test')
    await assert.rejects(setCoverAsset(p.id, photo, 'test'), (e: any) => e?.code === 'PERSONA_ARCHIVED')
  })

  await test('P2-6 到期日按北京时间当天结束；已到期授权只通知一次', async () => {
    const p = await createPersona({ name: '回归庚', line: 'manager', operator: 'test' })
    const pdf = join(temp, 'auth.pdf')
    ;(await import('node:fs')).writeFileSync(pdf, '%PDF-1.4\n%%EOF\n')
    const head = Buffer.alloc(16)
    Buffer.from('%PDF-1.4\n').copy(head)
    const auth = await uploadAuthorization({
      personaId: p.id, grantorName: '授权人', scopes: ['portrait'], effectiveFrom: '2026-01-01', expiresAt: '2027-06-30',
      filePath: pdf, filename: 'auth.pdf', size: statSync(pdf).size, head, operator: 'test',
    })
    assert.equal(auth.expiresAt, '2027-06-30T15:59:59.000Z')

    const now = toDb(utcNow())
    const expiredId = uid('auth')
    await db.run(
      `INSERT INTO persona_authorization (id, persona_id, grantor_name, scopes, file_key, file_mime, file_size, file_sha256,
         effective_from, expires_at, status, created_by, created_at, updated_at)
       VALUES (?, ?, 'x', '["portrait"]', 'k', 'application/pdf', 1, 'x', '2020-01-01', '2021-01-01 15:59:59', 'verified', 'test', ?, ?)`,
      [expiredId, p.id, now, now],
    )
    await scanAuthExpiry()
    await db.run('UPDATE persona_reminder SET read_at = ? WHERE ref_id = ?', [now, expiredId])
    await scanAuthExpiry()
    const logs = await db.get<{ c: number }>(
      "SELECT COUNT(*) AS c FROM operation_log WHERE action = 'persona.authorization_expired' AND detail LIKE ?",
      [`%${expiredId}%`],
    )
    assert.equal(Number(logs?.c), 1)
    const reminders = await db.get<{ c: number }>('SELECT COUNT(*) AS c FROM persona_reminder WHERE ref_id = ?', [expiredId])
    assert.equal(Number(reminders?.c), 1)
  })

  await test('P2-7 过期试听清理连同音频文件一起删除', async () => {
    const fs = await import('node:fs')
    const key = `persona/test/voice_preview/${uid('pvp')}.mp3`
    const local = join(paths.dataDir, 'oss', key)
    fs.mkdirSync(join(local, '..'), { recursive: true })
    fs.writeFileSync(local, 'mp3')
    const id = uid('pvp')
    await db.run(
      `INSERT INTO persona_voice_preview (id, voice_id, params_hash, text_hash, status, audio_key, created_at, expires_at)
       VALUES (?, 'v', ?, 't', 'ready', ?, '2020-01-01 00:00:00', '2020-01-08 00:00:00')`,
      [id, id, key],
    )
    assert.ok((await cleanExpiredPreviews()) >= 1)
    assert.equal(await db.get('SELECT id FROM persona_voice_preview WHERE id = ?', [id]), null)
    assert.equal(fs.existsSync(local), false)
  })

  await test('P2-8 提交任务丢失（内存队列重启）的 pending 分身由扫描补投', async () => {
    const k = await readyPersona('回归辛')
    const id = uid('pav')
    const old = toDb(new Date(Date.now() - 5 * 60_000))
    await db.run(
      `INSERT INTO persona_avatar (id, persona_id, name, source_asset_id, source_kind, vendor_title, short_ref,
         status, consent_id, authorization_id, idempotency_key, request_hash, created_at, updated_at)
       VALUES (?, ?, '丢失提交', 'asset', 'video', 't', ?, 'pending', 'c', ?, ?, 'h', ?, ?)`,
      [id, k.personaId, id.slice(-6), k.authId, id, old, old],
    )
    const waitingBefore = memQueueStats()['persona-clone']?.waiting ?? 0
    assert.ok((await sweepDuePolls()) >= 1)
    assert.ok((memQueueStats()['persona-clone']?.waiting ?? 0) > waitingBefore)
  })

  console.log(`${passed} persona regression groups passed`)
} finally {
  await closeQueues().catch(() => undefined)
  redis.disconnect()
  await closeAll()
  rmSync(temp, { recursive: true, force: true })
}
