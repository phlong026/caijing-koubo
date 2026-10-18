/** Renew a process registration, retaining TTL-based cleanup after a crash. */
export function startHeartbeat(
  client: { set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>; del(key: string): Promise<unknown> },
  key: string,
  value: string,
  onError: (error: unknown) => void,
  intervalMs = 60_000,
  ttlSeconds = 1800,
): () => Promise<void> {
  let stopped = false
  let pending: Promise<unknown> | null = null
  const renew = () => {
    if (stopped || pending) return
    pending = client.set(key, value, 'EX', ttlSeconds).catch(onError).finally(() => { pending = null })
  }
  renew()
  const timer = setInterval(renew, intervalMs)
  timer.unref()
  return async () => {
    stopped = true
    clearInterval(timer)
    await pending
    await client.del(key).catch(onError)
  }
}
