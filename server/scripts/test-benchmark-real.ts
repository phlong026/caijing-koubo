import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import axios from 'axios'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-real-'))
Object.assign(process.env, { DB_DRIVER: 'sqlite', DB_SQLITE_PATH: path.join(temp, 'test.db'), LOG_LEVEL: 'silent', TIKHUB_API_KEY: 'isolated-test-key', TIKHUB_RETRY: '1' })
const { initDb, closeAll } = await import('../src/db/index.js')
const { runMigrations } = await import('../src/db/migrate.js')
const { fetchUserPosts } = await import('../src/integrations/tikhub/client.js')
const { fetchAccountVideos } = await import('../src/modules/benchmark/fetch.js')
const { getVideoByPlatformId, listVideos } = await import('../src/modules/benchmark/videos.js')
const db = await initDb()
const originalGet = axios.get
let response: any = {}, calls = 0, failure: any = null
axios.get = (async () => { calls++; if (failure) throw failure; return { status: 200, data: response } }) as typeof axios.get
try {
  await runMigrations(db)
  response = { code: 200, data: { status_code: 0, has_more: 0, aweme_list: Array.from({ length: 6 }, (_, i) => ({ aweme_id: String(7000000000000000000n + BigInt(i)), desc: `真实接口归一化 ${i}`, duration: 5000, create_time: 1792281600 - i * 3600, statistics: { digg_count: i === 0 ? 10000 : 100, comment_count: 0, share_count: 0 }, video: { cover: { url_list: ['https://example.com/cover.jpg'] } } })) } }
  const page = await fetchUserPosts('test-sec')
  for (let i = 0; i < response.data.aweme_list.length; i++) {
    response.data.aweme_list[i].video.width = i === 1 ? 720 : 1920
    response.data.aweme_list[i].video.height = i === 1 ? 1280 : 1080
  }
  assert.equal(page.posts[0].duration, 5)
  assert.equal(page.posts.length, 6)
  assert.equal(page.posts[0].videoId, '7000000000000000000')
  response.data.aweme_list[0].video.cover.url_list = ['https://example.com/a.heic?sig=1', 'https://example.com/a.jpeg?sig=2']
  assert.equal((await fetchUserPosts('test-sec')).posts[0].coverUrl, 'https://example.com/a.jpeg?sig=2')
  console.log('PASS APP v3 视频 ID、毫秒时长与互动字段归一化')
  await db.run('INSERT INTO benchmark_account (id, platform, platform_uid, sec_uid, nickname, monitor_status, monitor_interval_hours) VALUES (?, ?, ?, ?, ?, ?, ?)', ['acct_real', 'douyin', 'uid_real', 'sec_real', '真实测试账号', 'on', 24])
  const result = await fetchAccountVideos('acct_real', { reason: 'add', backfill: true })
  assert.equal(result.newCount, 6)
  const first = await getVideoByPlatformId('douyin', '7000000000000000000')
  assert.equal(first?.isHot, true)
  assert.equal(first?.hotBaseline?.sample, 5)
  assert.equal(first?.hotBaseline?.threshold, 300)
  assert.equal((await db.get<{ c: number }>('SELECT COUNT(*) AS c FROM benchmark_alert'))?.c, 0)
  console.log('PASS 整页回填后统一判断，第一条高互动视频命中爆款且无回填告警')
  const normal = await getVideoByPlatformId('douyin', '7000000000000000001')
  assert.ok(normal?.hotBaseline)
  assert.equal(normal?.isHot, false)
  console.log('PASS 普通作品也保留可追溯判定快照')
  const again = await fetchAccountVideos('acct_real', { reason: 'add', backfill: true })
  assert.equal(again.newCount, 0)
  assert.equal((await listVideos({ dataSource: 'real' })).total, 6)
  assert.equal((await listVideos({ dataSource: 'real', format: 'portrait' })).total, 1)
  assert.equal((await listVideos({ dataSource: 'real', format: 'landscape' })).total, 5)
  assert.equal((await listVideos({ sort: 'interaction' })).items[0].interactTotal, 10000)
  console.log('PASS 重复同步、横竖屏筛选和互动排序')
  response = { code: 200, data: {} }
  await assert.rejects(fetchUserPosts('test-sec'), /未返回作品列表/)
  response = { code: 200, data: { status_code: 4, status_msg: '账号不可用' } }
  await assert.rejects(fetchUserPosts('test-sec'), /账号不可用/)
  console.log('PASS 无效上游结果不会被误报为成功的空列表')
  calls = 0
  failure = { response: { status: 403, data: { detail: { message_zh: 'API令牌已过期 isolated-test-key' } } } }
  await assert.rejects(fetchUserPosts('test-sec'), (e: Error) => e.message.includes('API令牌已过期') && !e.message.includes('isolated-test-key'))
  assert.equal(calls, 1)
  console.log('PASS 403 返回中文原因、隐藏凭据、不浪费重试调用')
} finally {
  axios.get = originalGet
  await closeAll()
  if (temp.startsWith(path.join(os.tmpdir(), 'benchmark-real-'))) fs.rmSync(temp, { recursive: true, force: true })
}
