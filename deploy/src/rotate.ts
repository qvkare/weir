// `rotate`: replaces named function-call keys on demand, for a key that may have been seen. The
// same rotation `topup` does for a key running out of allowance, in the same order:
//   1. the next-generation key is generated and saved in the credentials directory;
//   2. it is added on chain with the same receiver and methods, and the allowance a fresh key gets
//      (a month at the expected load, `allowanceFor`);
//   3. keeper.env is rewritten with it;
//   4. the chain is read back: the new key must be there with exactly that permission;
//   5. only then is the old key deleted on chain;
//   6. record.json is rewritten, so the public record lists the new public key.
// Resumable: a run stopped after 1 adds the saved key (no third key); a run stopped after 2 or 3
// finishes 3 to 6. Every transaction hash goes to state.json.
import type { KeyPair } from "../../chain/src/tx.ts";
import { allowanceFor, fmtNear, METHODS_OF } from "./budget.ts";
import type { DeployChain, KeyView } from "./chain.ts";
import type { Keystore } from "./keys.ts";
import { fcKeys, type FcKeyPlan, type Layout } from "./layout.ts";
import { writeState, type State } from "./state.ts";

export interface RotateContext {
  chain: DeployChain;
  keys: Keystore;
  layout: Layout;
  state: State;
  out: string;
  log: (line: string) => void;
  /** Rewrites keeper.env, record.json and deployments.json from the keystore's current keys. */
  writeOutputs: () => Promise<void>;
}

/** What `rotate` would do for one key. */
export interface RotationStep {
  key: FcKeyPlan;
  /** The keys of this account for this contract that are on chain now, oldest first. */
  onChain: { publicKey: string; generation: number }[];
  /** "fresh": generate and add a new key; "add": a saved key not yet on chain is added;
   * "finish": the new key is on chain, the old ones are still to be deleted. */
  action: "fresh" | "add" | "finish";
  /** The public key that will replace them, when it exists already (add, finish). */
  newPublicKey: string | null;
  newGeneration: number;
  allowance: bigint;
}

/** The keys `rotate --account <a> [--contract <c>]` replaces. Throws for anything that is not an
 * operator's function-call key in this layout. */
export function rotationTargets(l: Layout, account: string, contract?: string): FcKeyPlan[] {
  const acc = l.accounts.find((a) => a.id === account);
  if (!acc) throw new Error(`${account} is not an account of this deployment (${l.network.id}, suffix ${l.suffix})`);
  if (acc.role === "market" || acc.role === "usdc") throw new Error(`${account} is a contract account; rotate replaces operators' function-call keys only (a contract's full-access key is removed by seal)`);
  if (acc.role === "ops") throw new Error(`${account} is the ops parent; rotate replaces operators' function-call keys only, not full-access keys`);
  const mine = fcKeys(l).filter((k) => k.account === account);
  if (mine.length === 0) throw new Error(`${account} holds no function-call key in this layout`);
  if (contract === undefined) return mine;
  const one = mine.filter((k) => k.receiver === contract);
  if (one.length === 0) throw new Error(`${account} has no function-call key for ${contract}; its keys are for ${mine.map((k) => k.receiver).join(", ")}`);
  return one;
}

const fcView = (v: KeyView | undefined) => (v && v.permission !== "FullAccess" ? v.permission.FunctionCall : null);

/** Works out, from the keystore and the chain, what each target needs. Creates nothing. */
export async function planRotation(ctx: Pick<RotateContext, "chain" | "keys" | "layout">, targets: FcKeyPlan[]): Promise<RotationStep[]> {
  const out: RotationStep[] = [];
  for (const k of targets) {
    const all = await ctx.keys.allFunctionCall(k.account, k.receiver);
    const chainKeys = new Set((await ctx.chain.keys(k.account)).map((x) => x.public_key));
    const onChain = all.filter((x) => chainKeys.has(x.key.publicKeyString)).map((x) => ({ publicKey: x.key.publicKeyString, generation: x.generation }));
    const newest = all[all.length - 1];
    const allowance = allowanceFor(ctx.layout, k).allowance;
    if (!newest || onChain.length === 0) throw new Error(`${k.account} has no key for ${k.receiver} on chain that this credentials directory holds: nothing to rotate`);
    const newestOn = chainKeys.has(newest.key.publicKeyString);
    if (newestOn && onChain.length === 1) {
      out.push({ key: k, onChain, action: "fresh", newPublicKey: null, newGeneration: newest.generation + 1, allowance });
    } else if (newestOn) {
      out.push({ key: k, onChain, action: "finish", newPublicKey: newest.key.publicKeyString, newGeneration: newest.generation, allowance });
    } else {
      out.push({ key: k, onChain, action: "add", newPublicKey: newest.key.publicKeyString, newGeneration: newest.generation, allowance });
    }
  }
  return out;
}

export function renderRotation(steps: RotationStep[]): string {
  const o = ["Key rotation"];
  for (const s of steps) {
    const old = s.onChain.map((x) => `${x.publicKey} (generation ${x.generation})`).join(", ");
    const methods = METHODS_OF[s.key.methods].join(", ");
    if (s.action === "fresh") o.push(`  ${s.key.account} for ${s.key.receiver} [${methods}]: generate generation ${s.newGeneration}, add it with ${fmtNear(s.allowance, 2)} of allowance, rewrite keeper.env, check it on chain, then delete ${old}`);
    else if (s.action === "add") o.push(`  ${s.key.account} for ${s.key.receiver}: resume: add the saved generation ${s.newGeneration} ${s.newPublicKey} with ${fmtNear(s.allowance, 2)}, rewrite keeper.env, check it, then delete ${old}`);
    else o.push(`  ${s.key.account} for ${s.key.receiver}: resume: generation ${s.newGeneration} ${s.newPublicKey} is on chain; rewrite keeper.env, check it, then delete ${old.split(", ").filter((x) => !x.startsWith(s.newPublicKey!)).join(", ")}`);
  }
  return o.join("\n");
}

export async function rotate(ctx: RotateContext, targets: FcKeyPlan[]): Promise<{ sent: number; steps: RotationStep[] }> {
  const { chain, keys, state, log } = ctx;
  const steps = await planRotation(ctx, targets);
  log(renderRotation(steps));
  let sent = 0;
  const record = (id: string, purpose: string, tx: string) => {
    state.steps[id] = { purpose, tx, at: new Date().toISOString(), how: "sent" };
    state.updated_at = state.steps[id]!.at;
    writeState(ctx.out, state, keys.redactor);
    log(`sent  ${id}: tx ${tx}`);
    sent++;
  };
  const signer = async (id: string): Promise<{ accountId: string; key: KeyPair }> => {
    const key = await keys.existingFullAccess(id);
    if (!key) throw new Error(`no full-access key for ${id} in ${keys.dir}`);
    return { accountId: id, key };
  };

  // 1 and 2: the new keys, saved first, then added.
  const fresh: { step: RotationStep; next: KeyPair }[] = [];
  for (const s of steps) {
    const k = s.key;
    const methods = METHODS_OF[k.methods];
    let next: KeyPair;
    if (s.action === "fresh") next = await keys.nextFunctionCall(k.account, k.receiver, methods, s.newGeneration - 1);
    else next = (await keys.allFunctionCall(k.account, k.receiver)).find((x) => x.key.publicKeyString === s.newPublicKey)!.key;
    if (s.action !== "finish") {
      const o = await chain.send(await signer(k.account), k.account, [
        { type: "AddKey", publicKey: next.publicKey, permission: { receiverId: k.receiver, methodNames: [...methods], allowance: s.allowance } },
      ]);
      if (!o.ok) throw new Error(`adding ${k.account}'s new key for ${k.receiver} failed on chain (tx ${o.hash}): ${o.error}`);
      record(`rotate:${k.account}:${k.receiver}:${next.publicKeyString}`, `${k.account} adds a new key for ${k.receiver} with ${fmtNear(s.allowance, 2)} (rotate: replacing ${s.onChain.map((x) => x.publicKey).join(", ")})`, o.hash);
    }
    fresh.push({ step: s, next });
  }

  // 3: keeper.env with the new keys.
  await ctx.writeOutputs();
  log("keeper.env rewritten with the new keys; restart the keeper (or re-put its secrets) so it stops using the old ones");

  // 4 and 5: read back, then delete the old keys.
  for (const { step: s, next } of fresh) {
    const k = s.key;
    const view = fcView((await chain.keys(k.account)).find((x) => x.public_key === next.publicKeyString));
    const want = [...METHODS_OF[k.methods]].sort().join(",");
    if (!view || view.receiver_id !== k.receiver || [...view.method_names].sort().join(",") !== want) {
      throw new Error(`${k.account}'s new key ${next.publicKeyString} for ${k.receiver} is not on chain with the expected permission; the old key is kept. Run rotate again.`);
    }
    for (const old of s.onChain.filter((x) => x.publicKey !== next.publicKeyString)) {
      const kp = (await keys.allFunctionCall(k.account, k.receiver)).find((x) => x.key.publicKeyString === old.publicKey)!.key;
      const o = await chain.send(await signer(k.account), k.account, [{ type: "DeleteKey", publicKey: kp.publicKey }]);
      if (!o.ok) throw new Error(`deleting ${k.account}'s old key ${old.publicKey} failed on chain (tx ${o.hash}): ${o.error}`);
      record(`retire:${k.account}:${old.publicKey}`, `${k.account} deletes its replaced key for ${k.receiver} (rotate)`, o.hash);
    }
  }

  // 6: the public record.
  await ctx.writeOutputs();
  return { sent, steps };
}
