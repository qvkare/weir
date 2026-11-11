// `seal`: deletes every access key of the selected market contracts, in one transaction per
// contract signed by the key this tool saved for it. Afterwards nobody can deploy new code to
// the account, delete it or move its NEAR: the contract runs as it is for good. Only market
// contracts are sealed; the test token and the operator accounts are never touched.
import type { WireParams } from "../../engine/src/mod.ts";
import { base58Decode } from "../../chain/src/tx.ts";
import type { MarketId } from "../../agents/src/presets.ts";
import type { DeployChain } from "./chain.ts";
import type { Keystore } from "./keys.ts";
import type { Layout } from "./layout.ts";
import { expectedParams, paramsDiff, writeState, type State } from "./state.ts";
import type { Wasm } from "./wasm.ts";

export class SealRefused extends Error {
  override readonly name = "SealRefused";
}

/** Checks everything before anything is sent; returns the reasons it must not go ahead. */
export async function sealChecks(l: Layout, markets: readonly MarketId[], confirm: readonly string[], chain: DeployChain, keys: Keystore, weir: Wasm): Promise<string[]> {
  const why: string[] = [];
  for (const m of markets) {
    const id = l.contracts[m]!;
    if (!confirm.includes(id)) why.push(`${id}: not confirmed; pass --confirm ${id} to seal it`);
    const a = await chain.account(id);
    if (!a) {
      why.push(`${id} does not exist`);
      continue;
    }
    if (a.code_hash !== weir.codeHash) {
      why.push(`${id}: code ${a.code_hash} is not the local weir.wasm ${weir.codeHash}`);
      continue;
    }
    const p = await chain.view<WireParams>(id, "get_params", {});
    for (const d of paramsDiff(p, expectedParams(l, m, p.t0))) why.push(`${id}: ${d}`);
    const onChain = await chain.keys(id);
    if (onChain.length === 0) {
      why.push(`${id} is already sealed`);
      continue;
    }
    const mine = await keys.existingFullAccess(id);
    const signing = mine && onChain.find((k) => k.public_key === mine.publicKeyString && k.permission === "FullAccess");
    if (!signing) why.push(`${id}: no full-access key of it in ${keys.dir}, so this tool cannot sign the deletion`);
  }
  for (const c of confirm) if (!markets.some((m) => l.contracts[m] === c)) why.push(`--confirm ${c} names no selected market contract`);
  return why;
}

export async function seal(
  l: Layout, markets: readonly MarketId[], confirm: readonly string[], chain: DeployChain, keys: Keystore, weir: Wasm,
  state: State, out: string, log: (s: string) => void,
): Promise<void> {
  const why = await sealChecks(l, markets, confirm, chain, keys, weir);
  if (why.length > 0) throw new SealRefused(`not sealing anything:\n  - ${why.join("\n  - ")}`);
  for (const m of markets) {
    const id = l.contracts[m]!;
    const key = (await keys.existingFullAccess(id))!;
    const onChain = await chain.keys(id);
    // The signing key goes last; NEAR checks the signature before any action runs.
    const order = [...onChain.filter((k) => k.public_key !== key.publicKeyString), ...onChain.filter((k) => k.public_key === key.publicKeyString)];
    const o = await chain.send({ accountId: id, key }, id, order.map((k) => ({ type: "DeleteKey" as const, publicKey: base58Decode(k.public_key.replace(/^ed25519:/, "")) })));
    if (!o.ok) throw new Error(`sealing ${id} failed (tx ${o.hash}): ${o.error}`);
    const left = await chain.keys(id);
    if (left.length > 0) throw new Error(`${id} still has ${left.length} key(s) after tx ${o.hash}`);
    state.sealed[m] = { tx: o.hash, at: new Date().toISOString() };
    state.steps[`seal:${id}`] = { purpose: `seal ${id}: delete its ${order.length} access key(s)`, tx: o.hash, at: state.sealed[m]!.at, how: "sent" };
    state.updated_at = state.sealed[m]!.at;
    writeState(out, state, keys.redactor);
    log(`sealed ${id}: deleted ${order.length} key(s), tx ${o.hash}`);
  }
}
