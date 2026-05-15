/** True if `v` is a thenable — pulse treats any thenable as a promise. */
export function isPromise(v: unknown): v is Promise<unknown> {
  return (
    v != null &&
    (typeof v === 'object' || typeof v === 'function') &&
    typeof (v as { then?: unknown }).then === 'function'
  )
}
