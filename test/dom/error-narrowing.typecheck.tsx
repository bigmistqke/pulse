// This file exists purely to be typechecked (pnpm typecheck) — it has no
// runtime assertions and is not a vitest test. If <Errored>'s `for` stops
// narrowing `fallback`'s `error` parameter, the `.message`/`.code` accesses
// below stop compiling.
import { Errored } from '../../src/index'

class HttpError extends Error {
  readonly code: number
  constructor(message: string, code: number) {
    super(message)
    this.code = code
  }
}

function _typeGuardNarrowsFallbackError() {
  return (
    <Errored
      for={(e: unknown): e is HttpError => e instanceof HttpError}
      fallback={(error) => <p>{error.code}: {error.message}</p>}
    >
      {() => <span>content</span>}
    </Errored>
  )
}

function _plainPredicateDoesNotNarrow() {
  return (
    <Errored
      // A predicate with no narrowable shape — filtering by a property
      // value rather than by `instanceof`/`typeof` — so there is nothing
      // for TypeScript to infer a type predicate from. (A bare
      // `e instanceof HttpError` here would NOT demonstrate this: since
      // TypeScript 5.5, a function whose entire body is a single
      // `instanceof`/`typeof` check gets an inferred type predicate even
      // without an explicit `: e is HttpError` annotation, which would
      // narrow `error` below anyway and defeat this test's point.)
      for={(e: unknown) => (e as Error)?.message === 'boom'}
      // @ts-expect-error — a plain boolean predicate does not narrow E, so
      // `error` stays `unknown` here and `.code`/`.message` do not exist on it.
      fallback={(error) => <p>{error.code}</p>}
    >
      {() => <span>content</span>}
    </Errored>
  )
}

function _omittingForKeepsErrorUnknown() {
  return (
    <Errored
      // @ts-expect-error — no `for` at all means `E` stays the default
      // `unknown`, so `error.code` does not exist here either.
      fallback={(error) => <p>{error.code}</p>}
    >
      {() => <span>content</span>}
    </Errored>
  )
}
