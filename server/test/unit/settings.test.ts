import { describe, expect, it } from 'vitest'
import { config } from '../../src/config.js'
import { SETTING_DEFS, SETTING_GROUPS, SETTING_BY_KEY } from '../../src/modules/settings/catalog.js'
import { coerceValue, maskSecret } from '../../src/modules/settings/service.js'

function resolve(path: (string | number)[]): unknown {
  let cur: any = config
  for (const p of path) {
    if (cur == null || !(p in cur)) return undefined
    cur = cur[p as any]
  }
  return cur
}

describe('设置清单（catalog）', () => {
  it('key 全局唯一且与 SETTING_BY_KEY 一致', () => {
    const keys = SETTING_DEFS.map((d) => d.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(SETTING_BY_KEY.size).toBe(keys.length)
  })

  it('每条 path 都能定位到 config 中的已有字段（防 typo 静默失效）', () => {
    const bad = SETTING_DEFS.filter((d) => resolve(d.path) === undefined && d.type !== 'password')
      .map((d) => `${d.key} -> ${d.path.join('.')}`)
    // password 类字段可以为空串（=== undefined 判定排除空串），只报真正定位失败的
    expect(bad).toEqual([])
  })

  it('group 引用都在 SETTING_GROUPS 里；deploy 组全部 readonly', () => {
    const groupKeys = new Set(SETTING_GROUPS.map((g) => g.key))
    expect(SETTING_DEFS.every((d) => groupKeys.has(d.group))).toBe(true)
    const deploy = SETTING_DEFS.filter((d) => d.group === 'deploy')
    expect(deploy.length).toBeGreaterThan(0)
    expect(deploy.every((d) => d.readonly)).toBe(true)
  })

  it('readonly 项不可写：不参与热应用（保存侧由 service 拒绝）', () => {
    expect(SETTING_DEFS.filter((d) => d.readonly && d.group !== 'deploy')).toEqual([])
  })
})

describe('maskSecret（密钥脱敏）', () => {
  it('长密钥保留首尾 4 位', () => {
    expect(maskSecret('sk-KcFClUku9DGSXkmLZUJwwzQz4lblCK6iNirga1tSQrMMA1FB')).toBe('sk-K••••A1FB')
  })
  it('短值全遮、空值返回空', () => {
    expect(maskSecret('short')).toBe('••••••••')
    expect(maskSecret('')).toBe('')
  })
})

describe('coerceValue（.env 等价字符串转 config 类型）', () => {
  const def = (type: 'string' | 'number' | 'boolean') => ({ key: 'X', label: 'X', type, group: 'g', path: [] as string[] })

  it('number / boolean / string 正常转换', () => {
    expect(coerceValue(def('number'), '180000')).toBe(180000)
    expect(coerceValue(def('boolean'), 'true')).toBe(true)
    expect(coerceValue(def('boolean'), 'FALSE')).toBe(false)
    expect(coerceValue(def('string'), 'abc')).toBe('abc')
  })
  it('非法值抛出带字段名的错误', () => {
    expect(() => coerceValue(def('number'), 'abc')).toThrowError(/X/)
    expect(() => coerceValue(def('boolean'), 'yes')).toThrow()
  })
})
