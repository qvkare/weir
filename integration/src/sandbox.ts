// A local near-sandbox node: find the binary the Rust `near-sandbox` crate downloaded, start
// it with a fresh home directory on a known port, wait for its RPC, move its clock with
// `sandbox_fast_forward`, and stop it on exit, on failure and on Ctrl-C.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { NearRpc } from "../../chain/src/mod.ts";

/** The version near-sandbox 0.4 (the crate in contracts/Cargo.lock) installs by default. */
export const SANDBOX_VERSION = "2.14.0";

const CONTRACTS = new URL("../../contracts/", import.meta.url).pathname;

/** `NEAR_SANDBOX_BIN_PATH` (the crate's own override), else where the crate put it: the cargo
 * build output of `contracts/` (`$OUT_DIR/.near/near-sandbox-<version>/near-sandbox`), else
 * `~/.near` (the crate's `global_install` feature). */
export function findSandboxBinary(): string {
  const override = process.env.NEAR_SANDBOX_BIN_PATH;
  if (override) {
    if (!existsSync(override)) throw new Error(`NEAR_SANDBOX_BIN_PATH=${override} does not exist`);
    return override;
  }
  const candidates: string[] = [];
  for (const profile of ["debug", "release"]) {
    const build = join(CONTRACTS, "target", profile, "build");
    if (!existsSync(build)) continue;
    for (const dir of readdirSync(build).filter((d) => d.startsWith("near-sandbox-"))) {
      candidates.push(join(build, dir, "out", ".near", `near-sandbox-${SANDBOX_VERSION}`, "near-sandbox"));
    }
  }
  candidates.push(join(homedir(), ".near", `near-sandbox-${SANDBOX_VERSION}`, "near-sandbox"));
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      `no near-sandbox ${SANDBOX_VERSION} binary found. Run the Rust sandbox tests once ` +
        "(cargo test --manifest-path contracts/Cargo.toml -p weir --test sandbox), which downloads it, " +
        "or set NEAR_SANDBOX_BIN_PATH. Looked in:\n  " + candidates.join("\n  "),
    );
  }
  return found;
}

export interface SandboxOptions {
  port?: number;
  /** Seconds one fast-forwarded block moves the clock, roughly. Default 2. */
  secsPerBlock?: number;
  /** The normal block time, seconds. Default 0.06, half what `init --fast` writes: a transaction is final in about 0.3 s instead of 0.65 s. */
  minBlockSecs?: number;
  log?: (line: string) => void;
}

export interface RootAccount {
  accountId: string;
  secretKey: string;
}

export class Sandbox {
  readonly url: string;
  readonly home: string;
  readonly rpc: NearRpc;
  readonly binary: string;
  readonly version: string;
  readonly root: RootAccount;
  readonly #child: ChildProcess;
  #secsPerBlock: number;
  #stopped = false;
  /** Wall-clock ms spent inside `sandbox_fast_forward`. */
  fastForwardMs = 0;
  fastForwardBlocks = 0;

  private constructor(child: ChildProcess, url: string, home: string, binary: string, version: string, root: RootAccount, secsPerBlock: number) {
    this.#child = child;
    this.url = url;
    this.home = home;
    this.binary = binary;
    this.version = version;
    this.root = root;
    this.#secsPerBlock = secsPerBlock;
    this.rpc = new NearRpc({ urls: [url], timeoutMs: 60_000 });
  }

  static async start(opts: SandboxOptions = {}): Promise<Sandbox> {
    const binary = findSandboxBinary();
    const version = spawnSync(binary, ["--version"], { encoding: "utf8" }).stdout.trim();
    const port = opts.port ?? (process.env.WEIR_SANDBOX_PORT ? Number(process.env.WEIR_SANDBOX_PORT) : await freePortPair(33_031));
    const home = mkdtempSync(join(tmpdir(), "weir-sandbox-"));
    const init = spawnSync(binary, ["--home", home, "init", "--fast"], { encoding: "utf8" });
    if (init.status !== 0) throw new Error(`near-sandbox init failed: ${init.stderr}`);
    // A fast-forwarded block moves the clock by about (min + max block production delay) / 2.
    // Raising the max delay makes each skipped block cover more time, so an hour of market
    // time costs hundreds of blocks rather than twelve thousand. Normal block production is
    // unaffected: a single node produces at the min delay.
    const secsPerBlock = opts.secsPerBlock ?? 2;
    const configPath = join(home, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const minDelay = opts.minBlockSecs ?? 0.06;
    const maxDelay = 2 * secsPerBlock - minDelay;
    const delay = (s: number) => ({ secs: Math.floor(s), nanos: Math.round((s % 1) * 1e9) });
    config.consensus.min_block_production_delay = delay(minDelay);
    config.consensus.max_block_production_delay = delay(maxDelay);
    writeFileSync(configPath, JSON.stringify(config));
    // With that setting, 2.14.0 stops producing blocks at an epoch boundary after a few
    // fast-forwards (reproduced twice, at heights 361 and 2041, epoch length 60). One epoch for
    // the whole run avoids the boundary; a single local validator needs no rotation.
    const genesisPath = join(home, "genesis.json");
    const genesis = JSON.parse(readFileSync(genesisPath, "utf8"));
    genesis.epoch_length = 1_000_000;
    writeFileSync(genesisPath, JSON.stringify(genesis));
    const key = JSON.parse(readFileSync(join(home, "validator_key.json"), "utf8")) as { account_id: string; secret_key: string };

    const log = opts.log ?? (() => {});
    const child = spawn(binary, ["--home", home, "run", "--rpc-addr", `127.0.0.1:${port}`, "--network-addr", `127.0.0.1:${port + 1}`], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, RUST_LOG: process.env.NEAR_SANDBOX_LOG ?? "error" },
    });
    let stderr = "";
    child.stderr!.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4000);
    });
    const sandbox = new Sandbox(child, `http://127.0.0.1:${port}`, home, binary, version, { accountId: key.account_id, secretKey: key.secret_key }, secsPerBlock);
    registerCleanup(sandbox);
    const deadline = Date.now() + 60_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`near-sandbox exited with ${child.exitCode}: ${stderr}`);
      try {
        const res = await fetch(`${sandbox.url}/status`, { signal: AbortSignal.timeout(1000) });
        if (res.ok) {
          const height = await sandbox.height();
          if (height >= 2) break;
        }
      } catch {
        // not up yet
      }
      if (Date.now() > deadline) {
        sandbox.stop();
        throw new Error(`near-sandbox did not answer on ${sandbox.url} within 60 s: ${stderr}`);
      }
      await sleep(200);
    }
    log(`near-sandbox ${version} on ${sandbox.url}, home ${home}`);
    return sandbox;
  }

  async block(): Promise<{ height: number; timestamp: number; hash: string }> {
    const b = await this.rpc.call<{ header: { height: number; timestamp_nanosec: string; hash: string } }>("block", { finality: "final" });
    return { height: b.header.height, timestamp: Number(BigInt(b.header.timestamp_nanosec) / 1_000_000_000n), hash: b.header.hash };
  }

  async height(): Promise<number> {
    return (await this.block()).height;
  }

  /** Chain time in seconds: the final block's timestamp, as the contract reads it. */
  async now(): Promise<number> {
    return (await this.block()).timestamp;
  }

  /** Moves the clock to at least `target`, overshooting by at most about one fast-forwarded
   * block (`secsPerBlock`, 2 s by default). Gaps under two seconds are left to real blocks. */
  async warpTo(target: number, opts: { precise?: boolean } = {}): Promise<number> {
    for (;;) {
      const now = await this.now();
      if (now >= target) return now;
      const gap = target - now;
      // Precise: fast-forward only 80% of the gap at a time, so a misjudged block length can
      // never carry the clock past the target; real blocks cover the last few seconds.
      const blocks = opts.precise ? Math.floor((gap * 0.8) / this.#secsPerBlock) : gap <= 2 ? 0 : Math.max(1, Math.ceil((gap - 1) / this.#secsPerBlock));
      if (blocks < 1) {
        const before = await this.height();
        await sleep(Math.min(1000, gap * 1000));
        if ((await this.height()) === before) await this.assertAlive();
        continue;
      }
      const t = Date.now();
      await this.rpc.call("sandbox_fast_forward", { delta_height: blocks }, 120_000);
      this.fastForwardMs += Date.now() - t;
      this.fastForwardBlocks += blocks;
      const after = await this.#settle();
      if (blocks >= 20 && after > now) this.#secsPerBlock = Math.max(0.5, (after - now) / blocks);
    }
  }

  /** Waits until the final block's clock stops jumping (the fast-forward has landed). */
  async #settle(): Promise<number> {
    let last = await this.now();
    for (;;) {
      await sleep(150);
      const now = await this.now();
      if (now - last <= 2) return now;
      last = now;
    }
  }

  /** Throws if no block was produced for `secs` seconds: a stalled node fails the run
   * instead of hanging it. */
  async assertAlive(secs = 15): Promise<void> {
    const start = await this.height();
    const deadline = Date.now() + secs * 1000;
    while (Date.now() < deadline) {
      await sleep(250);
      if ((await this.height()) > start) return;
    }
    throw new Error(`near-sandbox produced no block for ${secs} s (stuck at height ${start})`);
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    try {
      this.#child.kill("SIGKILL");
    } catch {
      // already gone
    }
    try {
      rmSync(this.home, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

const live = new Set<Sandbox>();
let hooked = false;

function registerCleanup(s: Sandbox): void {
  live.add(s);
  if (hooked) return;
  hooked = true;
  const stopAll = () => {
    for (const x of live) x.stop();
  };
  process.on("exit", stopAll);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      stopAll();
      process.exit(130);
    });
  }
  process.on("uncaughtException", (e) => {
    stopAll();
    console.error(e);
    process.exit(1);
  });
  process.on("unhandledRejection", (e) => {
    stopAll();
    console.error(e);
    process.exit(1);
  });
}

/** The first port from `from` on where it and the next one are free (another run may hold 33031). */
async function freePortPair(from: number): Promise<number> {
  const { createServer } = await import("node:net");
  const free = (port: number) =>
    new Promise<boolean>((resolve) => {
      const srv = createServer();
      srv.once("error", () => resolve(false));
      srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
    });
  for (let p = from; p < from + 200; p += 2) if ((await free(p)) && (await free(p + 1))) return p;
  throw new Error(`no free port pair from ${from}`);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
