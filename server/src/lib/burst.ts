/**
 * 滑动窗口计数（P3-5）：统计最近 windowMs 内发生了几次。
 * 用于「偶发一次只记日志、短时间内反复出现就主动退出」这类判定。
 */
export function createBurstCounter(windowMs: number): { hit(now?: number): number; count(now?: number): number } {
  const times: number[] = []
  const prune = (now: number) => {
    while (times.length && now - times[0]! >= windowMs) times.shift()
  }
  return {
    hit(now = Date.now()) {
      prune(now)
      times.push(now)
      return times.length
    },
    count(now = Date.now()) {
      prune(now)
      return times.length
    },
  }
}
