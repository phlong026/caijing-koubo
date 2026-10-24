import type { PersonaLine, Platform } from './types.js'

/**
 * 平台 × 生产线矩阵（PB1 默认值，Q1 拍板后在此修订）。
 *
 * 依据《技术方案》§2.3 改造点⑤（原文有歧义，按任务书 v1.0 评审稿默认值执行）：
 *   经理 IP 线 → 快手 / 视频号 / 小红书（专业内容走非抖音渠道）；
 *   员工 KOS 线 / 素人矩阵 → 抖音（走量主阵地）。
 *
 * 校验口径：业务层强校验（越权 409 PLATFORM_LINE_FORBIDDEN），前端按 allowed 置灰。
 */

export const PLATFORM_LINE_MATRIX: Record<PersonaLine, Platform[]> = {
  manager: ['kuaishou', 'shipinhao', 'xiaohongshu'],
  kos: ['douyin'],
  persona: ['douyin'],
}

export function isPlatformAllowed(line: PersonaLine, platform: Platform): boolean {
  return PLATFORM_LINE_MATRIX[line]?.includes(platform) ?? false
}

export function allowedPlatforms(line: PersonaLine): Platform[] {
  return PLATFORM_LINE_MATRIX[line] ?? []
}
