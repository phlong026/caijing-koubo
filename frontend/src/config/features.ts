/**
 * 模块功能开关（Feature Flags）
 *
 * 审核工作台：文案与成片审核改为对接第三方审核（服务端自动送审、回收结果），
 * 桌面端不再展示人工复核页。开关关闭时：
 * - 侧边导航不渲染「审核工作台」入口
 * - /review 路由重定向回工作台
 * - 首页指标卡、待办与任务中心「查看审核」动作改跳对应业务模块
 * 服务端审核链（送审、关卡、校对台对接）不受影响，仍正常运行。
 *
 * 恢复方式：置 true，或以环境变量 VITE_ENABLE_REVIEW_WORKBENCH=1 启动（e2e 使用）。
 */
export const features = {
  reviewWorkbench: import.meta.env.VITE_ENABLE_REVIEW_WORKBENCH === '1',
} as const
