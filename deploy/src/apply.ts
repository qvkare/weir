// `apply`: works through the plan's steps in order. Before each step it reads the chain and
// skips the step if its effect is already there, so a run that stopped anywhere (a crash, a
// kill, a faucet outage) is finished by running it again. The state file is written after
// every step; it records hashes, and is never trusted over the chain.
import { CALLS } from "../../chain/src/weir.ts";
import { TOKEN_CALLS } from "../../chain/src/token.ts";
import { utf8Encode, type KeyPair } from "../../chain/src/tx.ts";
import type { WireAccount, WireParams } from "../../engine/src/mod.ts";
import { MARKETS } from "../../agents/src/presets.ts";
import { ACCOUNT_CREATION_CHARGE, contractNeed, fmtNear, GAS_PURCHASE_PRICE, purchase, STORAGE_PER_BYTE, TGAS } from "./budget.ts";
import { NO_CODE, type DeployAction, type DeployChain, type KeyView, type Sent } from "./chain.ts";
import type { Keystore } from "./keys.ts";
import { NEW_GAS_TGAS, type Plan, type Step } from "./steps.ts";
import { expectedParams, paramsDiff, writeState, type State } from "./state.ts";
import { chooseT0 } from "./t0.ts";
import type { Wasm } from "./wasm.ts";

export interface ApplyContext {
  chain: DeployChain;
  keys: Keystore;
  plan: Plan;
  wasm: { weir: Wasm; usdc: Wasm };
  out: string;
  state: State;
  log: (line: string) => void;
  /** Wall clock, for the state file's timestamps. */
  clock?: () => Date;
}

export interface ApplyResult {
  sent: number;
  skipped: number;
  sentSteps: string[];
}

const fc = (methodName: string, args: object, gas: bigint, deposit: bigint): DeployAction => ({ methodName, args: utf8Encode(JSON.stringify(args)), gas, deposit });

/** The function-call permission a key on chain has, in a comparable form. */
function permissionOf(k: KeyView): string {
  if (k.permission === "FullAccess") return "FullAccess";
  const p = k.permission.FunctionCall;
  return `FunctionCall:${p.receiver_id}:${[...p.method_names].sort().join(",")}`;
}

export class StepError extends Error {
  override readonly name = "StepError";
}

export async function isDone(ctx: ApplyContext, step: Step): Promise<boolean> {
  const { chain, keys, plan } = ctx;
  const l = plan.layout;
  switch (step.kind) {
    case "create-top":
    case "create-sub": {
      const id = step.account!;
      const acct = await chain.account(id);
      if (!acct) return false;
      const onChain = await chain.keys(id);
      const mine = await keys.existingFullAccess(id);
      if (mine && onChain.some((k) => k.public_key === mine.publicKeyString)) return true;
      // A sealed market keeps its code and has no keys at all.
      if (step.market && onChain.length === 0 && acct.code_hash === ctx.wasm.weir.codeHash && id === l.contracts[step.market]) return true;
      throw new StepError(
        `${id} exists but ${mine ? "does not hold the key saved in" : "has no key in"} ${keys.dir}: someone else owns this name, or the keys directory is not the one used before. Choose another --suffix or pass the right --keys.`,
      );
    }
    case "deploy-usdc": {
      const acct = await chain.account(step.account!);
      if (!acct || acct.code_hash === NO_CODE) return false;
      if (acct.code_hash !== ctx.wasm.usdc.codeHash) throw new StepError(`${step.account} runs code ${acct.code_hash}, not mock_usdc.wasm (${ctx.wasm.usdc.codeHash})`);
      return true;
    }
    case "deploy-market": {
      const acct = await chain.account(step.account!);
      if (!acct || acct.code_hash === NO_CODE) return false;
      if (acct.code_hash !== ctx.wasm.weir.codeHash) throw new StepError(`${step.account} runs code ${acct.code_hash}, not this weir.wasm (${ctx.wasm.weir.codeHash}); a sealed or deployed contract cannot be replaced by this tool`);
      const actual = await chain.view<WireParams>(step.account!, "get_params", {});
      const diff = paramsDiff(actual, expectedParams(l, step.market!, actual.t0));
      if (diff.length > 0) throw new StepError(`${step.account} was initialised with other parameters: ${diff.join("; ")}`);
      if (!ctx.state.t0[step.market!]) ctx.state.t0[step.market!] = { t0: actual.t0, reason: "read from get_params (the deploy was found on chain)" };
      return true;
    }
    case "storage":
      return (await chain.view<unknown>(l.usdc, "storage_balance_of", { account_id: step.account })) !== null;
    case "mint": {
      if (await depositDone(ctx, step)) return true;
      return BigInt(await chain.view<string>(l.usdc, "ft_balance_of", { account_id: step.account })) >= step.agent!.deposit;
    }
    case "register":
      return (await chain.view<WireAccount | null>(step.receiver, "get_account", { account_id: step.account })) !== null;
    case "deposit":
      return depositDone(ctx, step);
    case "guard": {
      const a = await chain.view<WireAccount | null>(l.contracts[step.market!]!, "get_account", { account_id: step.account });
      return a !== null && a.guard === step.agent!.guard && a.max_round_lock === step.agent!.maxRoundLock.toString();
    }
    case "add-key": {
      const k = step.key!;
      const kp = await keys.functionCall(k.account, k.receiver, k.methodNames);
      const found = (await chain.keys(k.account)).find((x) => x.public_key === kp.publicKeyString);
      if (!found) return false;
      const want = `FunctionCall:${k.receiver}:${[...k.methodNames].sort().join(",")}`;
      if (permissionOf(found) !== want) throw new StepError(`${k.account} holds key ${kp.publicKeyString} with ${permissionOf(found)}, expected ${want}`);
      return true;
    }
  }
}

/** A deposit is done if this tool recorded it, or the agent's free balance on its market
 * already covers it. Before the keeper runs nothing else moves that balance, so the second
 * test covers a run killed between sending the deposit and writing the state file. */
async function depositDone(ctx: ApplyContext, step: Step): Promise<boolean> {
  const id = `deposit:${step.account}`;
  if (ctx.state.steps[id]) return true;
  const a = await ctx.chain.view<WireAccount | null>(ctx.plan.layout.contracts[step.market!]!, "get_account", { account_id: step.account });
  return a !== null && BigInt(a.balance) >= step.agent!.deposit;
}

async function signer(ctx: ApplyContext, accountId: string): Promise<{ accountId: string; key: KeyPair }> {
  const key = await ctx.keys.existingFullAccess(accountId);
  if (!key) throw new StepError(`no full-access key for ${accountId} in ${ctx.keys.dir}`);
  return { accountId, key };
}

async function run(ctx: ApplyContext, step: Step): Promise<{ hash: string | null; sent?: Sent; note?: string }> {
  const { chain, keys, plan } = ctx;
  const l = plan.layout;
  const send = async (from: string, to: string, actions: DeployAction[]) => {
    const o = await chain.send(await signer(ctx, from), to, actions);
    if (!o.ok) throw new StepError(`${step.id} failed on chain (tx ${o.hash}): ${o.error}`);
    return { hash: o.hash, sent: o };
  };
  switch (step.kind) {
    case "create-top": {
      // The key is written to disk before the account is asked for, so it can never be lost.
      const key = await keys.fullAccess(step.account!);
      const r = await chain.createTopLevel(step.account!, key);
      return { hash: r.hash, note: r.note };
    }
    case "create-sub": {
      const key = await keys.fullAccess(step.account!);
      return send(l.ops, step.account!, [
        { type: "CreateAccount" },
        { type: "Transfer", deposit: step.attached },
        { type: "AddKey", publicKey: key.publicKey, permission: "FullAccess" },
      ]);
    }
    case "deploy-usdc":
      return send(step.account!, step.account!, [{ type: "DeployContract", code: ctx.wasm.usdc.bytes }]);
    case "deploy-market": {
      const m = step.market!;
      const need = contractNeed(ctx.wasm.weir.size, NEW_GAS_TGAS);
      const acct = await chain.account(step.account!);
      if (!acct || BigInt(acct.amount) < need.total) {
        throw new StepError(`${step.account} holds ${fmtNear(BigInt(acct?.amount ?? "0"))}; deploying weir.wasm needs at least ${fmtNear(need.total)}`);
      }
      const choice = chooseT0(MARKETS[m].params, await chain.now());
      const params = expectedParams(l, m, choice.t0);
      ctx.state.t0[m] = { t0: choice.t0, reason: choice.reason };
      ctx.log(`        ${choice.reason}`);
      return send(step.account!, step.account!, [
        { type: "DeployContract", code: ctx.wasm.weir.bytes },
        fc("new", { params }, NEW_GAS_TGAS * TGAS, 0n),
      ]);
    }
    case "storage":
      return send(l.ops, l.usdc, [fc("storage_deposit", { account_id: step.account, registration_only: true }, TOKEN_CALLS.storage_deposit.gas, TOKEN_CALLS.storage_deposit.deposit)]);
    case "mint":
      return send(l.ops, l.usdc, [fc("mint", { account_id: step.account, amount: step.agent!.deposit.toString() }, TOKEN_CALLS.mint.gas, 0n)]);
    case "register":
      return send(l.ops, step.receiver, [fc("register", { account_id: step.account }, CALLS.register.gas, CALLS.register.deposit)]);
    case "deposit": {
      const r = await send(step.account!, l.usdc, [
        fc("ft_transfer_call", { receiver_id: l.contracts[step.market!], amount: step.agent!.deposit.toString(), msg: "" }, TOKEN_CALLS.ft_transfer_call.gas, TOKEN_CALLS.ft_transfer_call.deposit),
      ]);
      if (String(r.sent.result) !== step.agent!.deposit.toString()) throw new StepError(`${step.id}: the market kept ${JSON.stringify(r.sent.result)} of ${step.agent!.deposit} (tx ${r.hash})`);
      return r;
    }
    case "guard":
      return send(step.account!, step.receiver, [
        fc("set_guard", { guard: step.agent!.guard, max_round_lock: step.agent!.maxRoundLock.toString() }, CALLS.set_guard.gas, CALLS.set_guard.deposit),
      ]);
    case "add-key": {
      const k = step.key!;
      const kp = await keys.functionCall(k.account, k.receiver, k.methodNames);
      return send(k.account, k.account, [
        { type: "AddKey", publicKey: kp.publicKey, permission: { receiverId: k.receiver, methodNames: [...k.methodNames], allowance: k.allowance } },
      ]);
    }
  }
}

/** Before the first step the ops account pays for, checks it can pay for all the remaining ones. */
async function checkOpsBalance(ctx: ApplyContext, pending: Step[]): Promise<void> {
  const l = ctx.plan.layout;
  const mine = pending.filter((s) => s.signer === l.ops);
  if (mine.length === 0) return;
  const acct = await ctx.chain.account(l.ops);
  if (!acct) return;
  // Attached NEAR, attached gas at the purchase price (an upper bound on what it burns), and the
  // creation charge of every account it creates.
  const need = mine.reduce((s, x) => s + x.attached + (x.gasTgas > 0n ? purchase(x.gasTgas * 1000n) : 0n) + (x.kind === "create-sub" ? ACCOUNT_CREATION_CHARGE + 10n ** 21n : 0n), 0n);
  if (BigInt(acct.amount) < need) {
    throw new StepError(
      `${l.ops} holds ${fmtNear(BigInt(acct.amount))} but the ${mine.length} steps it still has to pay for need up to ${fmtNear(need)}. ` +
        "Send it the difference, or lower --days, then run apply again.",
    );
  }
}

export async function apply(ctx: ApplyContext): Promise<ApplyResult> {
  const steps = ctx.plan.steps;
  const clock = ctx.clock ?? (() => new Date());
  const width = String(steps.length).length;
  const tag = (i: number) => `[${String(i + 1).padStart(width)}/${steps.length}]`;
  const save = () => {
    ctx.state.updated_at = clock().toISOString();
    writeState(ctx.out, ctx.state, ctx.keys.redactor);
  };
  // The budget rests on these prices; a network that asks more stops the run before it spends.
  const pc = await ctx.chain.protocol();
  ctx.log(
    `protocol ${pc.version}: gas price ${pc.gasPrice} yocto/gas${pc.gasPrice > 100_000_000n ? " (above the minimum the plan assumed: gas costs more than planned)" : " (the minimum, as planned)"}, ` +
      `attached gas bought at ${pc.gasPurchasePrice}, account creation charge ${fmtNear(pc.accountCreationCharge)}`,
  );
  if (pc.gasPurchasePrice > GAS_PURCHASE_PRICE || pc.accountCreationCharge > ACCOUNT_CREATION_CHARGE || pc.storagePerByte !== STORAGE_PER_BYTE) {
    throw new StepError(
      `the network's prices differ from the budget's (purchase ${pc.gasPurchasePrice} vs ${GAS_PURCHASE_PRICE}, creation ${pc.accountCreationCharge} vs ${ACCOUNT_CREATION_CHARGE}, ` +
        `storage ${pc.storagePerByte} vs ${STORAGE_PER_BYTE}); update deploy/src/budget.ts before deploying`,
    );
  }
  let sent = 0;
  let skipped = 0;
  const sentSteps: string[] = [];
  let opsChecked = false;
  for (const [i, step] of steps.entries()) {
    if (await isDone(ctx, step)) {
      skipped++;
      const rec = ctx.state.steps[step.id];
      if (!rec) {
        ctx.state.steps[step.id] = { purpose: step.purpose, tx: null, at: clock().toISOString(), how: "found on chain" };
        save();
      }
      ctx.log(`${tag(i)} skip  ${step.id}: already on chain${rec?.tx ? ` (tx ${rec.tx})` : ""}`);
      continue;
    }
    if (!opsChecked && step.signer === ctx.plan.layout.ops) {
      opsChecked = true;
      const pending: Step[] = [];
      for (const s of steps.slice(i)) if (s.signer === ctx.plan.layout.ops && !ctx.state.steps[s.id]) pending.push(s);
      await checkOpsBalance(ctx, pending);
    }
    const r = await run(ctx, step);
    ctx.state.steps[step.id] = {
      purpose: step.purpose, tx: r.hash, at: clock().toISOString(), how: "sent",
      ...(r.sent ? { gas_burnt: r.sent.gas_burnt } : {}),
    };
    save();
    sent++;
    sentSteps.push(step.id);
    ctx.log(`${tag(i)} sent  ${step.id}: tx ${r.hash ?? "(not returned by the faucet)"}${r.note ? ` (${r.note})` : ""}`);
    if (!(await isDone(ctx, step))) throw new StepError(`${step.id} was sent (tx ${r.hash}) but its effect is not visible on chain`);
  }
  return { sent, skipped, sentSteps };
}
