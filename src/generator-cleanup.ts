import type { Disposable } from 'r3'

/**
 * The cleanup list of the generator stage currently being driven, or null when
 * no generator stage is running.
 *
 * This is the "current X" ambient slot pattern with a save-restore wrapper. It
 * is sound here for the reason it would not be across `await`: pulse calls
 * `gen.next()` itself and regains control at every yield, so every segment of a
 * generator body runs synchronously inside the wrapper.
 *
 * It lives in its own module, importing only a type, so that both the driver
 * (which sets it) and the owner module (which reads it) can depend on it
 * without an import cycle.
 */
let current: Disposable[] | null = null

/** Run `fn` with `into` as the cleanup list any `onCleanup` call should join. */
export function collectGeneratorCleanups<T>(into: Disposable[], fn: () => T): T {
  const saved = current
  current = into
  try {
    return fn()
  } finally {
    current = saved
  }
}

/** The cleanup list to register with, or null when no generator is running. */
export function currentGeneratorCleanups(): Disposable[] | null {
  return current
}
