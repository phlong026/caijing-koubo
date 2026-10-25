import { describe, it, expect } from 'vitest'
import { safeFontFileName, assertFontMagic, fontBaseName, FONT_EXTENSIONS, LICENSE_TYPES } from '../../src/modules/material/fonts.js'
import { licenseStateOf } from '../../src/modules/material/voices.js'

/**
 * 素材库纯函数单测（ML1/ML3/ML6）：
 * 文件名清洗（路径穿越 / 白名单）、字体魔数（AC-F1 伪字体必须被拒）、声音授权状态归纳（AC-V1）。
 */

const magic = (...bytes: number[]) => Buffer.from([...bytes, 0, 0, 0, 0])

describe('safeFontFileName（ML3：白名单 + 禁路径穿越）', () => {
  it('保留合法中英文文件名', () => {
    expect(safeFontFileName('思源黑体-Bold.otf')).toBe('思源黑体-Bold.otf')
    expect(safeFontFileName('SourceHanSans.ttc')).toBe('SourceHanSans.ttc')
    expect(safeFontFileName('FZ.ttf')).toBe('FZ.ttf')
  })

  it('去掉目录部分，只留 basename', () => {
    expect(safeFontFileName('/etc/passwd/Evil.otf')).toBe('Evil.otf')
    expect(safeFontFileName('..\\..\\win\\FZ.ttf')).toBe('FZ.ttf')
    expect(safeFontFileName('../../a/b/c.otf')).toBe('c.otf')
  })

  it('清洗特殊字符与控制字符', () => {
    expect(safeFontFileName('a b\tc;d.otf')).toBe('a_b_c_d.otf')
    expect(safeFontFileName('...hidden.otf')).toBe('hidden.otf')
  })

  it('非白名单扩展名被拒（FONT_FORMAT_INVALID）', () => {
    for (const bad of ['font.woff', 'font.woff2', 'font.eot', 'font.svg', 'font.exe', 'font']) {
      expect(() => safeFontFileName(bad)).toThrowError(/仅支持/)
    }
  })

  it('清洗后为空被拒', () => {
    expect(() => safeFontFileName('----.otf')).not.toThrow()
    expect(() => safeFontFileName('///')).toThrowError(/文件名不合法/)
  })

  it('白名单常量与任务书 ML3 一致', () => {
    expect([...FONT_EXTENSIONS]).toEqual(['.otf', '.ttf', '.ttc'])
    expect([...LICENSE_TYPES]).toEqual(['ofl', 'commercial', 'other'])
  })
})

describe('assertFontMagic（AC-F1：伪字体必须被拒）', () => {
  it('接受 otf / ttf / ttc 三种合法容器', () => {
    expect(() => assertFontMagic(Buffer.from('OTTO'))).not.toThrow()
    expect(() => assertFontMagic(Buffer.from('ttcf'))).not.toThrow()
    expect(() => assertFontMagic(Buffer.from('true'))).not.toThrow()
    expect(() => assertFontMagic(Buffer.from([0x00, 0x01, 0x00, 0x00]))).not.toThrow()
  })

  it('拒绝 zip / png / 文本等伪装文件', () => {
    expect(() => assertFontMagic(Buffer.from('PK\u0003\u0004'))).toThrowError(/魔数不符/)
    expect(() => assertFontMagic(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toThrowError(/魔数不符/)
    expect(() => assertFontMagic(Buffer.from('<!DO'))).toThrowError(/魔数不符/)
  })

  it('头部不足 4 字节被拒', () => {
    expect(() => assertFontMagic(Buffer.from('OT'))).toThrowError(/文件过小/)
  })
})

describe('fontBaseName（字幕 fontName 口径）', () => {
  it('去掉扩展名，与 ASS Style 命名一致', () => {
    expect(fontBaseName('思源黑体-Bold.otf')).toBe('思源黑体-Bold')
    expect(fontBaseName('a.b.ttc')).toBe('a.b')
  })
})

describe('licenseStateOf（AC-V1：授权状态归纳）', () => {
  it('已试听确认 + 已绑授权 = 已核验', () => {
    expect(licenseStateOf({ confirmed: true, consentBound: true })).toBe('verified')
  })

  it('仅绑授权未确认 = 待核验', () => {
    expect(licenseStateOf({ confirmed: false, consentBound: true })).toBe('pending')
  })

  it('未绑授权 = 未绑定（无论是否试听）', () => {
    expect(licenseStateOf({ confirmed: true, consentBound: false })).toBe('unbound')
    expect(licenseStateOf({ confirmed: false, consentBound: false })).toBe('unbound')
  })
})
