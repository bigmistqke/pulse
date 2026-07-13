// NOTE: relies on the runtime's native GeneratorFunction constructor name.
// Generator/async transforms that target older ES versions (e.g. Babel ES5)
// may produce regular functions and break this check — pulse targets modern
// environments where native function shapes are preserved.
/** True if `f` is declared with `function*` (a generator function). */
export function isGeneratorFunction(
  f: unknown,
): f is (...args: unknown[]) => Generator<unknown, unknown, unknown> {
  return (
    typeof f === 'function' &&
    (f as { constructor?: { name?: string } }).constructor?.name === 'GeneratorFunction'
  )
}
