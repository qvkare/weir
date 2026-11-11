// The few Node APIs the tests use (src/ uses none), declared here so the package needs no
// dependency besides TypeScript. Signatures are narrowed to the forms actually called.

interface ImportMeta {
  readonly url: string;
}

declare class URL {
  constructor(url: string, base?: string | URL);
  readonly pathname: string;
}

declare const process: { readonly env: Record<string, string | undefined> };

declare module "node:crypto" {
  interface Hash {
    update(data: string, encoding: "utf8"): Hash;
    digest(encoding: "hex"): string;
  }
  export function createHash(algorithm: "sha256"): Hash;
}

declare module "node:fs" {
  export function existsSync(path: URL): boolean;
  export function readFileSync(path: URL, encoding: "utf8"): string;
}

declare module "node:test" {
  interface TestContext {
    skip(message?: string): void;
    diagnostic(message: string): void;
  }
  type TestFn = (t: TestContext) => void | Promise<void>;
  export function test(name: string, fn: TestFn): Promise<void>;
  export function describe(name: string, fn: () => void): Promise<void>;
  export function it(name: string, fn: TestFn): Promise<void>;
}

declare module "node:assert/strict" {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    ok(value: unknown, message?: string): asserts value;
    equal<T>(actual: unknown, expected: T, message?: string): asserts actual is T;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual<T>(actual: unknown, expected: T, message?: string): asserts actual is T;
    throws(fn: () => unknown, expected?: RegExp | { message: string | RegExp }, message?: string): void;
    fail(message?: string): never;
  }
  const assert: Assert;
  export default assert;
}
