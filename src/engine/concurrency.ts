export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Map `items` with at most `limit` in flight, preserving input order.
 *
 * Total by construction: every item yields exactly one slot. A rejection from `fn`
 * is mapped in place by `onError` — it never discards a sibling's completed result
 * and never rejects the join. `onError` is REQUIRED so a new caller cannot skip the
 * question "what result does a thrown item produce?" (that omission is bug #11).
 * The only remaining reject path is `onError` itself throwing, i.e. a defect.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
  onError: (item: T, error: unknown) => R,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const idx = next++
      try {
        results[idx] = await fn(items[idx]!)
      } catch (e) {
        results[idx] = onError(items[idx]!, e)
      }
    }
  }
  const size = Math.max(1, Math.min(limit, items.length))
  await Promise.all(Array.from({ length: size }, worker))
  return results
}

export async function retryTransient<T>(
  fn: () => Promise<T>,
  isTransient: (e: unknown) => boolean,
  retries = 2,
): Promise<T> {
  let attempt = 0
  for (;;) {
    try {
      return await fn()
    } catch (e) {
      if (attempt >= retries || !isTransient(e)) throw e
      attempt++
      await sleep(2 ** attempt * 100)
    }
  }
}
