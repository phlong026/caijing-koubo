import { detectMediaEnv } from '../src/modules/cut/engine.js'
import { config } from '../src/config.js'

/**
 * 剪辑渲染环境探测（任务书 AC-0.2 / CE0）：
 * 检查 ffmpeg 滤镜（ass / drawtext / silencedetect / amix / concat）与内置字体，
 * 输出缺失清单与引擎判定。部署清单要求 ffmpeg 带 --enable-libass --enable-freetype。
 */
const env = await detectMediaEnv(true)
const rows: Array<[string, boolean, string]> = [
  ['ffmpeg 可执行', env.ffmpeg, '安装 ffmpeg（brew install ffmpeg / apt install ffmpeg）'],
  ['ass 滤镜（libass）', env.ass, 'ffmpeg 需带 --enable-libass 编译项'],
  ['drawtext 滤镜（freetype）', env.drawtext, 'ffmpeg 需带 --enable-freetype 编译项'],
  ['silencedetect 滤镜', env.silencedetect, '标准构建自带'],
  ['amix 滤镜', env.amix, '标准构建自带'],
  ['concat 滤镜', env.concat, '标准构建自带'],
  [`内置字体（${config.cut.fontsDir}）`, !!env.fontFile, `放置 OFL 授权字体（如思源黑体）于该目录，当前文件：${env.fontFiles.join(', ') || '无'}`],
]
console.log('\n=== 剪辑渲染环境探测 ===\n')
let allOk = true
for (const [name, ok, hint] of rows) {
  if (!ok) allOk = false
  console.log(`  ${ok ? '✅' : '❌'} ${name}${ok ? '' : `  ← ${hint}`}`)
}
const engine = env.ffmpeg && env.ass && env.drawtext && env.fontFile ? 'ffmpeg（完整渲染）' : 'mock（字幕/尾页文字降级）'
console.log(`\n  渲染引擎判定：${engine}\n`)
process.exit(0)
