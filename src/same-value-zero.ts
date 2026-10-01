/** True if `a` and `b` are SameValueZero-equal: `===`, except that `NaN` equals
 *  `NaN`. This is the equality pulse uses to decide whether a value changed, the
 *  same one r3 applies (`===`) widened to `NaN`. */
export function sameValueZero(a: unknown, b: unknown): boolean {
  return a === b || (a !== a && b !== b)
}
