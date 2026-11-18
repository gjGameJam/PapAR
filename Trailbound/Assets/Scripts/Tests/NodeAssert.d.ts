declare module "node:assert/strict" {
  interface StrictAssert {
    (value: unknown, message?: string): asserts value
    equal(actual: unknown, expected: unknown, message?: string): void
  }
  const assert: StrictAssert
  export default assert
}
