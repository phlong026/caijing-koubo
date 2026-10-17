/**
 * FinStep 两个资讯源的单独验证脚本（只读采集，不入 news 表，但会记 api_call_log）。
 * 用法：npx tsx scripts/test-finstep.ts
 */
import { config, hasFinStep } from '../src/config.js'
import { providers } from '../src/modules/news/providers.js'
import { initDb, closeAll } from '../src/db/index.js'

async function main() {
  console.log('\n=== FinStep 资讯源验证 ===\n')
  if (!hasFinStep()) {
    console.log('❌ FINSTEP_API_KEY 未配置，先写入 server/.env 再运行')
    console.log('   FINSTEP_API_KEY=Bearer 后面的那串\n')
    process.exitCode = 1
    return
  }
  // api_call_log 需要库连接，否则每轮都会报 write_failed
  await initDb()
  console.log(`Base URL : ${config.finstep.baseUrl}`)
  console.log(`启用源   : ${config.finstep.enabledSources}`)
  console.log(`摘要上限 : ${config.finstep.summaryMaxChars} 字\n`)

  const targets = providers.filter((p) => p.name.startsWith('finstep_'))
  for (const p of targets) {
    console.log(`--- ${p.name}（${p.label}）enabled=${p.enabled} ---`)
    if (!p.enabled) {
      console.log('   跳过：source 未在 FINSTEP_SOURCES 中启用\n')
      continue
    }
    const started = Date.now()
    try {
      const items = await p.fetchLatest()
      const ms = Date.now() - started
      console.log(`   ✅ 取到 ${items.length} 条，耗时 ${(ms / 1000).toFixed(1)}s`)
      for (const it of items.slice(0, 4)) {
        console.log(`   · [${it.source}] ${it.title}`)
        console.log(`     externalId=${it.externalId}`)
        console.log(`     publishedAt=${it.publishedAt}  url=${it.contentUrl ?? '(无)'}`)
        const s = it.summary ?? ''
        console.log(`     summary(${s.length}字): ${s.slice(0, 110)}…`)
        // 脏数据自检
        if (/html|&lt;|&nbsp;|<\/?[a-z]/i.test(s)) console.log('     ⚠️ 摘要疑似残留 HTML')
        if (/^undefined$|undefined/.test(it.title)) console.log('     ⚠️ 标题含 undefined')
      }
      if (items.length > 4) console.log(`   … 其余 ${items.length - 4} 条略`)
      // externalId 唯一性自检
      const ids = new Set(items.map((i) => i.externalId))
      console.log(`   唯一性：${ids.size}/${items.length} ${ids.size === items.length ? '✅' : '❌ 有重复'}`)
    } catch (e) {
      console.log(`   ❌ 失败（${((Date.now() - started) / 1000).toFixed(1)}s）：${(e as Error).message}`)
    }
    console.log('')
  }
  await closeAll()
}

main().catch((e) => {
  console.error('脚本异常：', e)
  process.exit(1)
})
