import type { Db } from './index.js'
import { upsert } from './index.js'
import { toDb, utcNow } from '../lib/time.js'
import { config } from '../config.js'
import { newId } from '../lib/util.js'

/**
 * 视频创作模块种子（任务书 V0：示例素材包与关键词组）。
 *  - 关键词组：内置两条（is_builtin 语义用固定 id 表达，可编辑不可误删重建）；
 *  - 示例素材包：仅 SEED_DEMO 开发环境写入（source_path 指向本地目录，需先导入素材），
 *    与人物库「桩人物示例授权」同一口径，生产缺省关闭。
 * 幂等：按固定 id upsert，重复执行只刷新内容。
 */

const BUILTIN_KEYWORD_GROUPS: Array<{
  id: string
  name: string
  keywords: string[]
  durationMinMs: number
  durationMaxMs: number
  sort: number
}> = [
  {
    id: 'mkg_numbers',
    name: '数字与数据',
    keywords: ['数据', '增长', '下跌', '百分之', '收益率', '规模', '净值', '指数'],
    durationMinMs: 800,
    durationMaxMs: 2500,
    sort: 10,
  },
  {
    id: 'mkg_market',
    name: '市场与行情',
    keywords: ['A股', '股市', '行情', '板块', '基金', '债券', '央行', '利率', '大盘'],
    durationMinMs: 1000,
    durationMaxMs: 3000,
    sort: 20,
  },
]

export async function seedVideoModule(db: Db): Promise<void> {
  const now = toDb(utcNow())
  for (const g of BUILTIN_KEYWORD_GROUPS) {
    await upsert(db, {
      table: 'material_keyword_group',
      row: {
        id: g.id,
        name: g.name,
        keywords: JSON.stringify(g.keywords),
        pack_ids: JSON.stringify([]),
        duration_min_ms: g.durationMinMs,
        duration_max_ms: g.durationMaxMs,
        selection_mode: 'random',
        enabled: 1,
        sort: g.sort,
        updated_by: 'seed',
        updated_at: now,
      },
      uniqueCols: ['id'],
      updateCols: ['name', 'keywords', 'duration_min_ms', 'duration_max_ms', 'sort', 'updated_at'],
    })
  }

  if (config.seedDemo) {
    await upsert(db, {
      table: 'material_pack',
      row: {
        id: 'mp_demo',
        name: '示例素材包（演示）',
        line: null,
        source_path: 'materials/demo-pack',
        item_count: 0,
        enabled: 1,
        created_by: 'seed',
        created_at: now,
        updated_at: now,
      },
      uniqueCols: ['id'],
      updateCols: ['name', 'source_path', 'updated_at'],
    })
  }
}
