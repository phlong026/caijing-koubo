import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as turn } from 'node:timers/promises'
import { mock } from 'node:test'

const temp = mkdtempSync(join(tmpdir(), 'koubo-review-'))
process.env.DB_DRIVER = 'sqlite'
process.env.DB_SQLITE_PATH = join(temp, 'test.db')
process.env.TEMP_DIR = join(temp, 'tmp')
process.env.DASHSCOPE_API_KEY = ''
process.env.MOCK_FALLBACK = 'true'
process.env.LOG_LEVEL = 'silent'
const { initDb, closeAll } = await import('../src/db/index.js')
const { runMigrations } = await import('../src/db/migrate.js')
const { createTopic, createBatch, getBatch } = await import('../src/modules/topics/repo.js')
const { createDraftsFromTopics, createInitialDrafts } = await import('../src/modules/copy-contract/service.js')
const { runGeneration } = await import('../src/modules/topics/service.js')
const { scanCompliance } = await import('../src/modules/copy/text.js')
const { saveDraftContent, saveDraftVersion, restoreVersion } = await import('../src/modules/copy/service.js')
const { listDrafts, listVersions } = await import('../src/modules/copy/repo.js')
const { startHeartbeat } = await import('../src/queue/heartbeat.js')
const db = await initDb()
let passed = 0
async function test(name: string, fn: () => Promise<void> | void) {
  await fn(); passed++; console.log(`PASS ${name}`)
}
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r }); return { promise, resolve } }
try {
  await runMigrations(db)
  await db.exec('CREATE TABLE isolation_test (id TEXT PRIMARY KEY)')
  await test('concurrent root transactions and ordinary writes survive another transaction rollback', async () => {
    const entered = deferred(), release = deferred()
    const first = db.tx(async (tx) => {
      await tx.run('INSERT INTO isolation_test VALUES (?)', ['rollback'])
      entered.resolve(); await release.promise; throw new Error('rollback')
    })
    const rejection = assert.rejects(first, /rollback/)
    await entered.promise
    let secondStarted = false, plainFinished = false
    const second = db.tx(async (tx) => { secondStarted = true; await tx.run('INSERT INTO isolation_test VALUES (?)', ['second']) })
    const plain = db.run('INSERT INTO isolation_test VALUES (?)', ['plain']).then(() => { plainFinished = true })
    await turn()
    assert.equal(secondStarted, false); assert.equal(plainFinished, false)
    release.resolve(); await Promise.all([rejection, second, plain])
    assert.deepEqual((await db.all<{ id: string }>('SELECT id FROM isolation_test ORDER BY id')).map((r) => r.id), ['plain', 'second'])
  })
  await test('true nested transactions share ownership and roll back together', async () => {
    await assert.rejects(db.tx(async () => {
      await db.tx(async (nested) => { await nested.run('INSERT INTO isolation_test VALUES (?)', ['nested']) })
      throw new Error('nested rollback')
    }), /nested rollback/)
    assert.equal(await db.get('SELECT * FROM isolation_test WHERE id = ?', ['nested']), null)
  })
  const personas = await db.all<{ id: string }>('SELECT id FROM persona ORDER BY id LIMIT 2')
  assert.equal(personas.length, 2)
  const pids = personas.map((p) => p.id)
  const topic = await createTopic({ source: 'manual', title: '事务回归选题', status: 'assigned', personaIds: pids })
  await test('second persona insert failure rolls back sent status and all copies; retry is idempotent', async () => {
    await db.exec(`CREATE TRIGGER fail_copy BEFORE INSERT ON copy WHEN NEW.persona_id = '${pids[1]}' BEGIN SELECT RAISE(ABORT, 'injected copy failure'); END`)
    await assert.rejects(createDraftsFromTopics({ topicIds: [topic.id] }), /injected copy failure/)
    assert.equal((await db.get<{ status: string }>('SELECT status FROM topic WHERE id = ?', [topic.id]))?.status, 'assigned')
    assert.equal((await db.get<{ c: number }>('SELECT COUNT(*) c FROM copy WHERE topic_id = ?', [topic.id]))?.c, 0)
    await db.exec('DROP TRIGGER fail_copy')
    const results = await Promise.all([createDraftsFromTopics({ topicIds: [topic.id] }), createDraftsFromTopics({ topicIds: [topic.id] })])
    assert.equal(results.reduce((sum, r) => sum + r.created, 0), 2)
    assert.equal((await createDraftsFromTopics({ topicIds: [topic.id] })).created, 0)
  })
  await db.run('INSERT INTO news_item (id, external_id, source, category, title) VALUES (?, ?, ?, ?, ?)', ['review-news', 'review-news', 'test', '其他', '测试新闻'])
  await test('resume a partial pair and reconcile stale produced count; completed rows before finalization remain done', async () => {
    const batch = await createBatch({ newsIds: ['review-news'], personaIds: [pids[0]!], countPer: 3 })
    await createTopic({ source: 'news', sourceId: 'review-news', title: '中断前留下的选题', batchId: batch.id, personaIds: [pids[0]!] })
    await runGeneration(batch.id)
    assert.equal((await getBatch(batch.id))?.produced, 3)
    assert.equal((await getBatch(batch.id))?.status, 'done')
    await db.run("UPDATE topic_generation_batch SET status = 'running', produced = 0 WHERE id = ?", [batch.id])
    await runGeneration(batch.id)
    assert.equal((await getBatch(batch.id))?.status, 'done')
    assert.equal((await getBatch(batch.id))?.produced, 3)
  })
  await test('partial success stays persisted and failed pairs are retried without duplicating successful pairs', async () => {
    const batch = await createBatch({ newsIds: ['review-news'], personaIds: pids, countPer: 2 })
    await db.exec(`CREATE TRIGGER fail_topic BEFORE INSERT ON topic WHEN NEW.persona_ids = '["${pids[1]}"]' AND NEW.title LIKE '%角度2%' BEGIN SELECT RAISE(ABORT, 'injected topic failure'); END`)
    await assert.rejects(runGeneration(batch.id), /injected topic failure/)
    assert.equal((await getBatch(batch.id))?.produced, 2)
    assert.equal((await getBatch(batch.id))?.status, 'failed')
    await db.exec('DROP TRIGGER fail_topic')
    await runGeneration(batch.id)
    assert.equal((await getBatch(batch.id))?.produced, 4)
    assert.equal((await getBatch(batch.id))?.status, 'done')
    await runGeneration(batch.id)
    assert.equal((await getBatch(batch.id))?.produced, 4)
  })
  await test('overlapping workers never overfill the same pair', async () => {
    const batch = await createBatch({ newsIds: ['review-news'], personaIds: [pids[0]!], countPer: 3 })
    await Promise.all([runGeneration(batch.id), runGeneration(batch.id)])
    assert.equal((await getBatch(batch.id))?.produced, 3)
    assert.equal((await db.get<{ c: number }>('SELECT COUNT(*) c FROM topic WHERE batch_id = ?', [batch.id]))?.c, 3)
  })
  await test('plain 不 persona prohibitions catch affirmative claims and retain negative disclaimers', () => {
    for (const [rule, claim] of [['不推荐具体产品', '推荐具体产品'], ['不预测具体点位', '预测具体点位'], ['不给出个股买卖建议', '个股买卖建议']]) {
      assert.ok(scanCompliance([{ label: '正文', text: `我会${claim}。` }], [], [rule!]).some((h) => h.fromPersona))
    }
    assert.equal(scanCompliance([{ label: '正文', text: '不推荐具体产品。' }], [], ['不推荐具体产品']).length, 0)
    assert.ok(scanCompliance([], [], ['不预测具体点位'], '预测具体点位').length)
  })
  await test('autosaved draft can create manual snapshot, deduplicate it and restore historical content', async () => {
    const copy = await db.get<{ id: string }>('SELECT id FROM copy WHERE topic_id = ? LIMIT 1', [topic.id])
    await createInitialDrafts([copy!.id], 'review-test')
    let draft = (await listDrafts(copy!.id))[0]!
    draft = (await saveDraftContent(copy!.id, draft.id, { title: '版本一', sections: [{ label: '正文', text: '历史内容' }], rev: draft.rev }, 'review-test')).draft
    assert.equal((await listVersions(copy!.id)).length, 0)
    const snapshot = await saveDraftVersion(copy!.id, draft.id, 'review-test')
    assert.equal(snapshot.created, true)
    assert.equal((await saveDraftVersion(copy!.id, draft.id, 'review-test')).created, false)
    await saveDraftContent(copy!.id, draft.id, { title: '版本二', sections: [{ label: '正文', text: '新的内容' }], rev: draft.rev }, 'review-test')
    const restored = await restoreVersion(copy!.id, snapshot.version.id, 'review-test')
    assert.equal(restored.draft.title, '版本一')
    assert.equal(restored.draft.sections[0]?.text, '历史内容')
    assert.equal(restored.version.origin, 'restore')
  })
  await test('heartbeat renews beyond initial TTL, retries transient failure, and stops cleanly', async () => {
    mock.timers.enable({ apis: ['setInterval'] })
    let sets = 0, deletes = 0, errors = 0
    const stop = startHeartbeat({
      async set() { sets++; if (sets === 2) throw new Error('transient') },
      async del() { deletes++ },
    }, 'instance', 'db', () => { errors++ })
    await turn()
    for (let minute = 0; minute < 32; minute++) { mock.timers.tick(60_000); await turn() }
    assert.equal(sets, 33); assert.equal(errors, 1)
    await stop(); mock.timers.tick(60_000); await turn()
    assert.equal(sets, 33); assert.equal(deletes, 1)
    mock.timers.reset()
  })
  await test('article text decoding (P2-13c): UTF-8, BOM, UTF-16 and GBK', async () => {
    const { decodeText } = await import('../src/modules/copy/article.js')
    const text = '定投的三个误区'
    assert.equal(decodeText(Buffer.from(text, 'utf8')), text)
    assert.equal(decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')])), text)
    assert.equal(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])), text)
    // 「定投」的 GBK 编码
    assert.equal(decodeText(Buffer.from([0xb6, 0xa8, 0xcd, 0xb6])), '定投')
  })
  await test('temp cleanup (P2-13c): only own files past retention; clears article storage_path', async () => {
    const { cleanupTempFiles, writeTempFile } = await import('../src/modules/copy/article.js')
    const { paths } = await import('../src/config.js')
    const { mkdirSync, writeFileSync, existsSync, utimesSync } = await import('node:fs')
    mkdirSync(paths.tempDir, { recursive: true })
    const oldArticle = writeTempFile('old.txt', Buffer.from('x'))
    const newArticle = writeTempFile('new.txt', Buffer.from('y'))
    const stray = join(paths.tempDir, 'up_0123456789abcdef0123.jpg')
    const foreign = join(paths.tempDir, 'someone-else.txt')
    writeFileSync(stray, 'z'); writeFileSync(foreign, 'z')
    const longAgo = (Date.now() - 40 * 86_400_000) / 1000
    for (const f of [oldArticle, stray, foreign]) utimesSync(f, longAgo, longAgo)
    await db.run("INSERT INTO article_source (id, filename, mime, size, storage_path, plain_text, outline, word_count, created_by, created_at) VALUES ('art_cleanup', 'old.txt', 'text/plain', 1, ?, 'x', '[]', 1, 't', '2026-01-01 00:00:00')", [oldArticle])
    const r = await cleanupTempFiles()
    assert.deepEqual(r, { articles: 1, stray: 1 })
    assert.equal(existsSync(oldArticle), false); assert.equal(existsSync(newArticle), true)
    assert.equal(existsSync(stray), false); assert.equal(existsSync(foreign), true)
    assert.equal((await db.get<{ storage_path: string | null }>("SELECT storage_path FROM article_source WHERE id = 'art_cleanup'"))?.storage_path, null)
  })
  await test('Mutex (P2-13d): keys are independent, same key is exclusive, queued waiters get a direct hand-off', async () => {
    const { Mutex } = await import('../src/lib/util.js')
    const m = new Mutex('test')
    const a = deferred(), b = deferred()
    const order: string[] = []
    const runA = m.run('a', async () => { order.push('a:start'); await a.promise; order.push('a:end'); return 'A' })
    const runB = m.run('b', async () => { order.push('b:start'); await b.promise; order.push('b:end'); return 'B' })
    await turn()
    assert.deepEqual(order, ['a:start', 'b:start'])
    assert.equal(await m.run('a', async () => 'dup', () => 'busy'), 'busy')
    b.resolve(); assert.equal(await runB, 'B')
    // b 结束不能释放 a 的锁（原实现会整体解锁）
    assert.equal(await m.run('a', async () => 'dup', () => 'busy'), 'busy')
    const queued = m.runQueued('a', async () => { order.push('q:run'); return 'Q' }, 5_000)
    await turn()
    a.resolve(); assert.equal(await runA, 'A')
    // 移交给排队者的瞬间，非排队调用不能插队
    assert.equal(await m.run('a', async () => 'dup', () => 'busy'), 'busy')
    assert.equal(await queued, 'Q')
    assert.equal(m.busy, false)
    assert.equal(await m.runQueued('a', async () => 'free', 10), 'free')
  })
  await test('rate limiter (P2-12): bursts up to the per-minute budget, then refills over time', async () => {
    const { takeToken, resetBuckets } = await import('../src/lib/rate-limit.js')
    resetBuckets()
    const t0 = 1_000_000
    for (let i = 0; i < 4; i++) assert.equal(takeToken('k', { perMinute: 4 }, t0).ok, true)
    const denied = takeToken('k', { perMinute: 4 }, t0)
    assert.equal(denied.ok, false)
    assert.ok(!denied.ok && denied.retryAfterSec > 0 && denied.retryAfterSec <= 15)
    assert.equal(takeToken('other', { perMinute: 4 }, t0).ok, true)
    assert.equal(takeToken('k', { perMinute: 4 }, t0 + 15_000).ok, true)
    assert.equal(takeToken('k', { perMinute: 4 }, t0 + 15_000).ok, false)
  })
  console.log(`${passed} regression groups passed`)
} finally {
  mock.timers.reset()
  await closeAll()
  rmSync(temp, { recursive: true, force: true })
}
