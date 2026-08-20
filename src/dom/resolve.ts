/**
 * Reads `props[key]`, correctly distinguishing two shapes that look
 * identical once you've already read the value out:
 *
 * - A getter (from the props-to-getters compiler, or hand-authored) - read
 *   it once. Whatever it returns is the final value, even if that's itself
 *   a function (e.g. a nested control-flow component's own live accessor,
 *   from `<Loading><Errored>...</Errored></Loading>`) - a getter already
 *   represents "the resolved value," so it is never called further here.
 * - A plain property holding a function - the author's own explicit
 *   accessor or render-prop (e.g. `{() => <TodoList/>}`, or
 *   `{(item) => <li>{item}</li>}`), which the compiler always leaves as a
 *   real function since it excludes existing function expressions from
 *   getter-conversion. This one DOES need calling (with `args`) to produce
 *   the value.
 *
 * This is only for a prop typed as a duck-typed union with a function form
 * (`Loading.children: Child | (() => unknown)`, `For.each`,
 * `Show`/`Match`'s `when` and `children`) - a plain `Child`-only prop like
 * `fallback`/`initial` should just be read directly (`props.fallback`) and
 * passed through untouched, function value or not, for insertChild to
 * handle - it is never meant to be called by the component that owns it.
 */
export function readDynamic(props: object, key: PropertyKey, ...args: unknown[]): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(props, key)
  if (descriptor === undefined) return undefined
  if (descriptor.get) return descriptor.get.call(props)
  return typeof descriptor.value === 'function'
    ? (descriptor.value as (...a: unknown[]) => unknown)(...args)
    : descriptor.value
}
