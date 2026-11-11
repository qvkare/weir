// The few Node APIs the CLI and tests use, declared here so the package needs no
// dependency besides TypeScript. Browser globals (fetch, crypto, TextEncoder) come from lib DOM.

declare const process: {
  readonly argv: string[];
  exitCode: number | undefined;
};

declare module "node:fs" {
  export function existsSync(path: string | URL): boolean;
  export function readFileSync(path: string | URL): Uint8Array;
  export function readFileSync(path: string | URL, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string | Uint8Array): void;
  export function mkdirSync(path: string, options: { recursive: true }): void;
  export function readdirSync(path: string): string[];
}

declare module "node:test" {
  type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): Promise<void>;
}

declare module "node:assert/strict" {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    ok(value: unknown, message?: string): asserts value;
    equal<T>(actual: unknown, expected: T, message?: string): asserts actual is T;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual<T>(actual: unknown, expected: T, message?: string): asserts actual is T;
    throws(fn: () => unknown, expected?: RegExp, message?: string): void;
    match(value: string, pattern: RegExp, message?: string): void;
  }
  const assert: Assert;
  export default assert;
}
