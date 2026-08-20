/**
 * Combines multiple props-shaped objects into one, later sources overriding
 * earlier ones for the same key - like `{...a, ...b}` - but copying property
 * DESCRIPTORS (`Object.defineProperty`) instead of values. Native spread (and
 * rest-destructuring) reads through a getter once and copies the resulting
 * value as a plain property, permanently flattening it. This preserves a
 * getter as a getter, so a live prop forwarded through `<Comp {...props}/>`
 * (or through this framework's own props merging) stays live on the other
 * side.
 */
export function mergeProps(...sources: object[]): Record<string, unknown> {
  const target: Record<string, unknown> = {}
  for (const source of sources) {
    const descriptors = Object.getOwnPropertyDescriptors(source)
    for (const key of Reflect.ownKeys(descriptors)) {
      Object.defineProperty(target, key, descriptors[key as string])
    }
  }
  return target
}
