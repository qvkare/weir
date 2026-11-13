"use client";
// The test bid (lib/app-views.ts, "try"): one sealed bid in the hourly market from this browser,
// by a throwaway testnet account. The chain side (@weir/chain/guest: key, faucet, signing) is
// loaded with a dynamic import when this view opens, so no other page carries it. The view's
// state is lib/try-state.ts: the same steps whoever signs the setup, so a wallet can sign it
// later beside the guest without a second view.
import Link from "next/link";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { buttonClass } from "@/components/ui/button.ts";
import { ExternalIcon } from "@/components/icons.tsx";
import { useRefreshAt } from "@/components/live.tsx";
import { withMarket, type MarketId } from "@/lib/config.ts";
import { dollarsOfPrice, fmtBps, fmtCountdown, fmtUsdExact, fmtUtcTime } from "@/lib/format.ts";
import type { SiteConfig } from "@/lib/site-config.ts";
import {
  adviceFor,
  bidButton,
  deliveryEnd,
  guestKey,
  guestStorage,
  hasOpenBid,
  forfeitOf,
  initialTry,
  localKV,
  missedReveal,
  phaseNow,
  readStored,
  settleable,
  STEP_IDS,
  stepLabel,
  storageWorks,
  tryReducer,
  type KV,
  type PlanView,
  type ResultLike,
  type Row,
  type StepId,
  type TryState,
} from "@/lib/try-state.ts";
import { cn } from "@/lib/utils.ts";
import { ChipRow, Panel } from "./parts.tsx";
import { ShellFrame, type ShellProps } from "./views.tsx";

/** The only market with rounds short enough to watch one through. */
export const TRY_MARKET: MarketId = "h100-fast";
const PLAN_POLL_SECS = 15;
const EXPLORER = "https://testnet.nearblocks.io";

type RunLib = typeof import("@/lib/try-run.ts");

export function TryView(p: ShellProps) {
  if (p.market !== TRY_MARKET) {
    return (
      <ShellFrame {...p} chips={<ChipRow label="Test bid" />}>
        <Panel title="Test bid">
          <p className="m-0 max-w-[64ch] text-sm text-muted-foreground">
            The test bid runs on the hourly market, where a round takes five minutes. <Link href={withMarket("/try", TRY_MARKET)}>Place one there</Link>.
          </p>
        </Panel>
      </ShellFrame>
    );
  }
  const c = p.cfg.contracts[TRY_MARKET];
  return (
    <ShellFrame {...p} chips={<ChipRow label="Test bid" bar={<span className="text-xs text-muted-foreground">NEAR {p.cfg.network}, test dollars only</span>} />}>
      <GuestBid cfg={p.cfg} contractId={c?.contract ?? null} usdcId={c?.usdc ?? null} />
    </ShellFrame>
  );
}

/** The wall clock in ms, once a second. */
function useTicker(): number {
  const [t, setT] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setT(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return t;
}

/** Runs `f` holding this guest's lock, so two tabs never drive one bid. `onHeld` when another tab holds it. */
async function withLock(name: string, f: () => Promise<void>, onHeld: () => void): Promise<void> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (!locks) return f();
  await locks.request(name, { ifAvailable: true }, async (lock) => {
    if (!lock) onHeld();
    else await f();
  });
}

function GuestBid({ cfg, contractId, usdcId }: { cfg: SiteConfig; contractId: string | null; usdcId: string | null }) {
  const target = useMemo(() => (contractId ? { contractId, usdcId, rpcUrls: cfg.rpc } : null), [contractId, usdcId, cfg.rpc]);
  const key = guestKey(contractId ?? "none");
  const mode = contractId ? cfg.mode : "none";
  const [st, dispatch] = useReducer(tryReducer, undefined, () => initialTry("guest"));
  const [storageOk, setStorageOk] = useState<boolean | null>(null);
  const [plan, setPlan] = useState<PlanView | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [elsewhere, setElsewhere] = useState(false);
  const wall = useTicker();
  const now = plan ? plan.now + (wall - plan.readAt) / 1000 : wall / 1000;
  const kv = useRef<KV | null>(null);
  const inFlight = useRef(false);
  const lib = useRef<Promise<RunLib> | null>(null);
  const loadLib = useCallback(() => (lib.current ??= import("@/lib/try-run.ts")), []);
  const stored = () => readStored(kv.current?.getItem(key) ?? null);

  const planBusy = useRef(false);
  const readPlan = useCallback(async () => {
    if (!target || mode !== "chain" || planBusy.current) return;
    planBusy.current = true;
    try {
      const m = await loadLib();
      setPlan(await m.readTryPlan(target));
      setPlanError(null);
    } catch (e) {
      setPlanError(e instanceof Error ? e.message : String(e));
    } finally {
      planBusy.current = false;
    }
  }, [target, mode, loadLib]);
  // When the phase the plan read ends, read it again at once (also while a bid runs, so the
  // round on screen is the round now).
  useRefreshAt(plan && plan.phaseEndsAt !== null ? plan.readAt + (plan.phaseEndsAt - plan.now) * 1000 : null, plan?.readAt ?? 0, () => void readPlan());

  const go = useCallback(
    async (kind: "bid" | "again" | "resume") => {
      if (inFlight.current || !kv.current || !target) return;
      const store = kv.current;
      inFlight.current = true;
      setBusy(true);
      setElsewhere(false);
      const fresh = () => readStored(store.getItem(key));
      try {
        await withLock(
          key,
          async () => {
            const m = await loadLib();
            const guest = await m.openGuest(target, store, (e) => {
              dispatch({ type: "event", e, at: Date.now() });
              dispatch({ type: "stored", stored: fresh() });
            });
            if (kind === "again") {
              await guest.nextBid();
              dispatch({ type: "next", stored: fresh() });
            }
            dispatch({ type: "start", at: Date.now() });
            try {
              dispatch({ type: "result", result: await guest.run() });
            } catch (e) {
              dispatch({ type: "error", error: m.viewError(e) });
            }
            dispatch({ type: "stored", stored: fresh() });
          },
          () => setElsewhere(true),
        );
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        dispatch({ type: "error", error: { kind: "unknown", message, refusal: null, advice: adviceFor("unknown", null) } });
      } finally {
        inFlight.current = false;
        setBusy(false);
        void readPlan();
      }
    },
    [target, key, loadLib, readPlan],
  );

  // On open: is there storage, and a stored guest? A sealed bid is resumed at once: it must be revealed.
  useEffect(() => {
    const store = localKV();
    const ok = storageWorks(store);
    kv.current = ok ? store : null;
    setStorageOk(ok);
    if (!ok) return;
    const s = readStored(store!.getItem(key));
    dispatch({ type: "restore", stored: s });
    if (hasOpenBid(s) && mode === "chain") void go("resume");
  }, [key, mode, go]);

  // The plan, every 15 s while nothing runs and the tab is visible.
  useEffect(() => {
    if (busy || mode !== "chain") return;
    void readPlan();
    const id = setInterval(() => {
      if (!document.hidden && !inFlight.current) void readPlan();
    }, PLAN_POLL_SECS * 1000);
    return () => clearInterval(id);
  }, [busy, mode, readPlan]);

  // Leaving with a sealed bid not yet revealed: the browser asks first.
  const sealedOpen = !!st.sealed && st.rows.reveal.status !== "done";
  useEffect(() => {
    if (!sealedOpen) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [sealedOpen]);

  const settle = async (series: number[]) => {
    if (inFlight.current || !kv.current || !target) return;
    const store = kv.current;
    inFlight.current = true;
    setBusy(true);
    dispatch({ type: "settle-start" });
    try {
      const m = await loadLib();
      const guest = await m.openGuest(target, store, (e) => dispatch({ type: "event", e, at: Date.now() }));
      const txs: { method: string; hash: string; ok: boolean }[] = [];
      let last: Awaited<ReturnType<typeof guest.settle>> | null = null;
      for (const s of series) {
        last = await guest.settle(s);
        txs.push(...last.txs);
        if (!last.settled) break;
      }
      if (last) dispatch({ type: "settle-done", settled: last.settled, reason: last.reason, balance: last.balance, txs });
    } catch (e) {
      const m = await loadLib();
      dispatch({ type: "settle-error", error: m.viewError(e) });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const forget = () => {
    if (!kv.current) return;
    if (!window.confirm("Forget this test account? Its key is deleted from this browser and cannot be recovered. The account and its test dollars stay on testnet, out of reach.")) return;
    guestStorage(kv.current).forget(key);
    dispatch({ type: "forget" });
  };

  // While it runs the button says so; the reason line is for an idle page.
  const running = st.run === "running" || busy;
  // A sealed bid this page is not driving (a failed reveal, another tab): offer to resume it.
  const open = storageOk === true && hasOpenBid(stored());
  const btn = bidButton({ mode, storage: storageOk !== false, busy: busy || elsewhere, open, plan, planError, now });
  const resumable = open && !running && !elsewhere && mode === "chain";

  return (
    <>
      <Panel title="Place one sealed bid">
        <p className="m-0 max-w-[68ch] text-base text-foreground">
          The page makes a NEAR testnet account, funds it with test dollars and commits one sealed order to the round now: LONG 5 GPU-hours at the price below. When the reveal phase opens it reveals the order, then reads the clearing price and your fill, about five minutes in all.
        </p>
        <p className="m-0 mt-4 max-w-[68ch] rounded-lg bg-background/60 px-4 py-3 text-sm text-muted-foreground ring-1 ring-border">
          This makes a throwaway NEAR testnet account. Its key stays in this browser&rsquo;s storage. Test dollars only. Clearing your browser data loses it.
        </p>
      </Panel>

      <Panel title="The round now" note={mode === "chain" ? `Read from the chain in this browser, again every ${PLAN_POLL_SECS} s` : null}>
        <PlanFigures plan={plan} planError={planError} now={now} mode={mode} mine={st.sealed} />
        {resumable ? (
          <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2">
            <button type="button" className={cn(buttonClass("primary", "md"), "cursor-pointer border-0 font-sans")} onClick={() => void go("resume")}>
              Resume the sealed bid
            </button>
            <p className="m-0 text-sm text-muted-foreground">Your bid in round {stored()?.order?.round} is committed and not yet cleared. The page reveals it and reads the fill.</p>
          </div>
        ) : st.run !== "done" ? (
          <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2">
            <button type="button" className={cn(buttonClass("primary", "md"), "cursor-pointer border-0 font-sans disabled:cursor-not-allowed disabled:opacity-50")} disabled={!btn.enabled || running} onClick={() => void go("bid")}>
              {running ? "Bidding" : "Place a test bid"}
            </button>
            <p className="m-0 min-h-5 text-sm text-muted-foreground" aria-live="polite">
              {running ? "Follow the steps below." : elsewhere ? "Another tab of this site is placing this browser's bid. Follow it there." : btn.reason}
              {!running && btn.until !== null ? (
                <>
                  {" "}
                  The next commit phase opens in <Secs left={btn.until - now} />.
                </>
              ) : null}
            </p>
          </div>
        ) : (
          <p className="m-0 mt-5 text-sm text-muted-foreground">Your bid in round {st.result?.round} has cleared. The result is below.</p>
        )}
      </Panel>

      <Panel title="Steps" note={st.accountId ? <AccountLink id={st.accountId} /> : "No test account in this browser yet"}>
        {sealedOpen ? <SealedNote st={st} plan={plan} now={now} /> : null}
        <ol className="m-0 list-none p-0">
          {STEP_IDS.map((id) => (
            <StepRow key={id} id={id} row={st.rows[id]} label={id === "reveal" && missedReveal(st.result) ? "Not revealed in time" : stepLabel(id, st.signer)} wait={st.wait} wall={wall} />
          ))}
        </ol>
        {st.wait?.step === "plan" && running ? (
          <p className="m-0 mt-3 text-sm text-muted-foreground">
            Waiting for the next commit phase, <Secs left={(st.wait.until - wall) / 1000} />.
          </p>
        ) : null}
        {st.error ? <ErrorNote error={st.error} /> : null}
        {st.accountId ? (
          <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-4">
            <button type="button" className={cn(buttonClass("ghost", "sm"), "cursor-pointer border-0 bg-transparent px-0 font-sans disabled:cursor-not-allowed disabled:opacity-50")} disabled={running} onClick={forget}>
              Forget this account
            </button>
            <span className="text-xs text-muted-foreground">{running ? "Not while a call is in flight." : open ? "Its sealed bid would stay unrevealed and lose 1% of its lock." : "Deletes its key from this browser. The next bid makes a new account."}</span>
          </div>
        ) : null}
      </Panel>

      {st.result ? (
        <Panel title={`Result, round ${st.result.round} of series ${st.result.series}`}>
          {missedReveal(st.result) ? <MissedNote r={st.result} forfeitBps={plan?.forfeitBps ?? 100} /> : null}
          <ResultFigures r={st.result} tick={plan?.tick} />
          <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2">
            <button type="button" className={cn(buttonClass("primary", "md"), "cursor-pointer border-0 font-sans disabled:cursor-not-allowed disabled:opacity-50")} disabled={!btn.enabled || running} onClick={() => void go("again")}>
              Bid again in the next round
            </button>
            <p className="m-0 text-sm text-muted-foreground" aria-live="polite">
              {running ? null : btn.reason ? `${btn.reason} ` : "Same account, no new one. "}
              {!running && btn.until !== null ? (
                <>
                  The next commit phase opens in <Secs left={btn.until - now} />.
                </>
              ) : null}
            </p>
          </div>
          <SettleBlock st={st} plan={plan} now={now} busy={running} onSettle={(s) => void settle(s)} />
          {st.history.length ? <History rows={st.history} tick={plan?.tick} /> : null}
        </Panel>
      ) : st.history.length ? (
        <Panel title="Earlier bids">
          <History rows={st.history} tick={plan?.tick} />
          <SettleBlock st={st} plan={plan} now={now} busy={running} onSettle={(s) => void settle(s)} />
        </Panel>
      ) : null}
    </>
  );
}

// ── Parts ────────────────────────────────────────────────────────

/** A transaction link's words: what it did, not the contract method it called. */
const TX_LABEL: Record<string, string> = {
  create_account: "Account transaction",
  register: "Registration",
  "storage_deposit+mint+ft_transfer_call": "Deposit",
  "storage_deposit+ft_transfer_call": "Deposit",
  ft_transfer_call: "Deposit",
  commit: "Sealed commit",
  reveal: "Reveal",
  clear: "Clearing",
  settle: "Settlement",
  redeem: "Redemption",
};
const txLabel = (method: string): string => TX_LABEL[method] ?? "Transaction";

/** A countdown in mono figures with the site's one-second beat. Never shifts: tabular figures, fixed width. */
function Secs({ left }: { left: number }) {
  const secs = Math.max(0, Math.floor(left));
  return (
    <time className="inline-flex items-center gap-1.5 font-mono tabular-nums text-foreground" dateTime={`PT${secs}S`}>
      {secs > 0 ? <span className="tick-dot" key={secs} aria-hidden="true" /> : null}
      {fmtCountdown(secs)}
    </time>
  );
}

function Figure({ label, value, sub }: { label: string; value: ReactNode; sub: ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg bg-background/60 p-4 ring-1 ring-border">
      <p className="m-0 text-xs text-muted-foreground">{label}</p>
      <p className="m-0 mt-1 font-mono text-2xl tabular-nums text-foreground">{value}</p>
      <p className="m-0 mt-1 max-w-none text-xs text-muted-foreground">{sub}</p>
    </div>
  );
}

function PlanFigures({ plan, planError, now, mode, mine }: { plan: PlanView | null; planError: string | null; now: number; mode: string; mine: TryState["sealed"] }) {
  if (mode !== "chain") return <p className="m-0 text-sm text-muted-foreground">{mode === "model" ? "This build shows the model. The test bid needs the market on testnet." : "The hourly market is not deployed."}</p>;
  if (!plan) {
    return planError ? (
      <div className="state error" role="alert">
        <p>The NEAR RPC did not answer. The page reads it again in {PLAN_POLL_SECS} s.</p>
      </div>
    ) : (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" role="status" aria-label="Reading the market">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-[104px] rounded-lg bg-background/60 ring-1 ring-border" aria-hidden="true">
            <span className="skeleton m-4 block h-4 w-2/3" />
          </div>
        ))}
      </div>
    );
  }
  const ph = phaseNow(plan, now);
  const tick = plan.tick;
  const o = plan.order;
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Figure label="Series, round" value={plan.series !== null ? `${plan.series} · ${plan.round ?? "–"}` : "none"} sub={plan.series !== null ? "Hourly delivery, five-minute rounds" : "No series is in its auction window"} />
        <Figure
          label={ph ? `${ph.phase} phase, left` : "Phase"}
          value={ph ? <Secs left={ph.endsAt - now} /> : "closed"}
          sub={ph ? `${ph.phase === "Commit" ? "Commit" : "Reveal"} ends ${fmtUtcTime(ph.endsAt, true)}` : "No round is in progress"}
        />
        <Figure
          label="Last clearing price"
          value={plan.lastClearing && plan.floor !== null ? dollarsOfPrice(plan.floor + plan.lastClearing.price, tick) : "none"}
          sub={plan.lastClearing ? `/GPU-h, round ${plan.lastClearing.round} of this series` : o ? "None in this series yet; the order starts from the last index print" : "Read while a commit phase is open"}
        />
        {mine ? (
          <Figure label={`Your sealed order, round ${mine.round}`} value={<span className="text-long">LONG {mine.size}</span>} sub={`GPU-h at most ${dollarsOfPrice(mine.floor + mine.price, tick)} /GPU-h. Lock ${fmtUsdExact(mine.lock)}`} />
        ) : (
          <Figure
            label="Suggested order"
            value={o ? <span className="text-long">LONG {o.size}</span> : "none"}
            sub={o && plan.floor !== null ? `GPU-h at most ${dollarsOfPrice(plan.floor + o.price, tick)} /GPU-h. Lock ${fmtUsdExact(o.lock)}, fee ${fmtUsdExact(o.fee)}` : "Shown while a commit phase is open"}
          />
        )}
      </div>
    </>
  );
}

function SealedNote({ st, plan, now }: { st: TryState; plan: PlanView | null; now: number }) {
  const o = st.sealed!;
  const ph = plan ? phaseNow(plan, now) : null;
  const waitRow = st.wait && st.wait.step === "reveal" ? Math.max(0, Math.round((st.wait.until - Date.now()) / 1000)) : null;
  const left = waitRow ?? (ph?.phase === "Commit" ? Math.max(0, Math.round(ph.endsAt - now)) : null);
  const forfeit = plan ? forfeitOf(o.lock, plan.forfeitBps) : null;
  return (
    <div className="mb-4 rounded-lg bg-background/60 px-4 py-3 ring-1 ring-border" role="status">
      <p className="m-0 text-sm font-medium text-foreground">
        Keep this tab open until the reveal{left !== null ? <>, about <span className="font-mono tabular-nums">{left}</span> s</> : null}.
      </p>
      <p className="m-0 mt-1 text-xs text-muted-foreground">
        Your order is sealed in round {o.round}. If this page is closed before it is revealed, {plan ? fmtBps(plan.forfeitBps) : "1%"} of its lock{forfeit !== null ? ` (${fmtUsdExact(forfeit)})` : ""} is forfeited when the round clears. Reloading is safe: the page reveals it when it opens again.
      </p>
    </div>
  );
}

function StepRow({ id, row, label, wait, wall }: { id: StepId; row: Row; label: string; wait: TryState["wait"]; wall: number }) {
  const waiting = row.status === "active" && wait && ((id === "revealWait" && wait.step === "reveal") || (id === "clearWait" && wait.step === "clear"));
  return (
    <li className="grid grid-cols-[14px_minmax(0,1fr)_auto] items-start gap-x-3 border-t border-border py-3 first:border-t-0">
      <Marker status={row.status} />
      <div className="min-w-0">
        <p className={cn("m-0 text-sm", row.status === "todo" ? "text-muted-foreground" : "text-foreground")}>
          {label}
          <span className="sr-only">: {row.status === "todo" ? "not yet" : row.status === "active" ? "in progress" : row.status === "done" ? "done" : "failed"}</span>
        </p>
        {row.refusals.map((t, i) => (
          <p key={i} className="m-0 mt-0.5 break-words text-xs text-muted-foreground">
            The contract answered: <span className="font-mono text-foreground">&ldquo;{t}&rdquo;</span>
          </p>
        ))}
        {row.txs.length ? (
          <p className="m-0 mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs">
            {row.txs.map((t) => (
              <a key={t.url} href={t.url} target="_blank" rel="noopener noreferrer" className={cn("whitespace-nowrap", !t.ok && "text-flag")}>
                {txLabel(t.method)}
                {t.ok ? "" : " (failed)"} <ExternalIcon />
                <span className="sr-only"> (transaction on nearblocks, opens in a new tab)</span>
              </a>
            ))}
          </p>
        ) : null}
      </div>
      <span className="text-xs">{waiting ? <Secs left={(wait.until - wall) / 1000} /> : null}</span>
    </li>
  );
}

function Marker({ status }: { status: Row["status"] }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "mt-1 block size-2.5 rounded-[2px] transition-colors",
        status === "todo" && "ring-1 ring-border",
        status === "active" && "bg-transparent ring-2 ring-foreground",
        status === "done" && "bg-foreground",
        status === "failed" && "bg-flag",
      )}
    />
  );
}

function ErrorNote({ error }: { error: NonNullable<TryState["error"]> }) {
  return (
    <div className="state error mt-4" role="alert">
      {error.refusal ? (
        <p>
          The contract refused: <span className="font-mono">&ldquo;{error.refusal}&rdquo;</span>
        </p>
      ) : (
        <p className="break-words">{error.message}</p>
      )}
      <p>{error.advice}</p>
    </div>
  );
}

function AccountLink({ id }: { id: string }) {
  return (
    <a href={`${EXPLORER}/address/${encodeURIComponent(id)}`} target="_blank" rel="noopener noreferrer" className="font-mono">
      {id} <ExternalIcon />
      <span className="sr-only"> (account on nearblocks, opens in a new tab)</span>
    </a>
  );
}

function MissedNote({ r, forfeitBps }: { r: ResultLike; forfeitBps: number }) {
  return (
    <div className="mb-4 rounded-lg bg-background/60 px-4 py-3 ring-1 ring-border" role="status">
      <p className="m-0 text-sm font-medium text-foreground">The order was not revealed in time.</p>
      <p className="m-0 mt-1 text-sm text-muted-foreground">
        The page was away while the reveal phase of round {r.round} ran. {fmtBps(forfeitBps)} of the lock ({fmtUsdExact(forfeitOf(r.order.lock, forfeitBps))}) is forfeited when the round clears; the rest of the lock ({fmtUsdExact(BigInt(r.order.lock) - forfeitOf(r.order.lock, forfeitBps))}) is back in the free balance. You can bid again with the same account.
      </p>
    </div>
  );
}

function ResultFigures({ r, tick }: { r: ResultLike; tick: number | undefined }) {
  const size = r.order.size * Math.max(1, (r.order.seqs ?? []).length);
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Figure label="Clearing price" value={r.clearingPriceAbs !== null ? dollarsOfPrice(r.clearingPriceAbs, tick) : "none"} sub={r.clearingPriceAbs !== null ? `/GPU-h; your limit ${dollarsOfPrice(r.order.floor + r.order.price, tick)}` : "The round did not trade"} />
        <Figure label="Filled" value={`${r.filled} of ${size}`} sub={missedReveal(r) ? "GPU-h: not revealed in time" : `GPU-h: ${r.outcome}`} />
        <Figure label="Position" value={<span className={r.position.long ? "text-long" : undefined}>{r.position.long ? `LONG ${r.position.long}` : r.position.short ? `SHORT ${r.position.short}` : "none"}</span>} sub={`GPU-h in series ${r.series}; paid at settlement`} />
        <Figure label="Free balance" value={fmtUsdExact(r.balance)} sub="Test dollars in the market, after clearing" />
      </div>
    </>
  );
}

function SettleBlock({ st, plan, now, busy, onSettle }: { st: TryState; plan: PlanView | null; now: number; busy: boolean; onSettle: (series: number[]) => void }) {
  const ready = settleable(st, plan, now);
  const latest = st.result ?? st.history.at(-1) ?? null;
  const s = st.settle;
  return (
    <div className="mt-5 border-t border-border pt-4">
      {ready.length ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <button type="button" className={cn(buttonClass("secondary", "md"), "cursor-pointer border-0 font-sans disabled:cursor-not-allowed disabled:opacity-50")} disabled={busy} onClick={() => onSettle(ready)}>
            {s?.status === "running" ? "Settling" : "Settle and redeem"}
          </button>
          <span className="text-sm text-muted-foreground">Series {ready.join(", ")}: the delivery hour is over. Settling pays the position out at the fixing.</span>
        </div>
      ) : latest && plan ? (
        <p className="m-0 text-sm text-muted-foreground">Settle and redeem opens when the delivery hour of series {latest.series} is over, at {fmtUtcTime(deliveryEnd(plan, latest.series))}, and the reporters have printed it.</p>
      ) : null}
      {s && s.status !== "running" ? (
        s.status === "done" ? (
          <p className="m-0 mt-3 text-sm text-foreground">
            Settled and redeemed. Free balance {s.balance !== null ? fmtUsdExact(s.balance) : "no data"}. {s.txs.map((t) => <TxLink key={t.url} {...t} />)}
          </p>
        ) : (
          <div className="state error mt-3" role="alert">
            {s.refusal ? (
              <p>
                The contract refused: <span className="font-mono">&ldquo;{s.refusal}&rdquo;</span>
              </p>
            ) : (
              <p className="break-words">{s.note}</p>
            )}
            <p>Try again later: settling needs the delivery hour&rsquo;s prints.</p>
          </div>
        )
      ) : null}
    </div>
  );
}

function TxLink({ method, url, ok }: { method: string; url: string; ok: boolean }) {
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="mr-3 whitespace-nowrap text-xs">
      {txLabel(method)}
      {ok ? "" : " (failed)"} <ExternalIcon />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

function History({ rows, tick }: { rows: ResultLike[]; tick: number | undefined }) {
  return (
    <div className="mt-5">
      <p className="m-0 mb-2 text-xs text-muted-foreground">Earlier bids from this account</p>
      <ul className="m-0 grid list-none gap-1 p-0 text-sm">
        {[...rows].reverse().map((r) => (
          <li key={`${r.series}-${r.round}`} className="text-muted-foreground">
            Series {r.series}, round {r.round}: filled <span className="font-mono tabular-nums text-foreground">{r.filled}</span> of {r.order.size}
            {r.clearingPriceAbs !== null ? (
              <>
                {" "}at <span className="font-mono tabular-nums text-foreground">{dollarsOfPrice(r.clearingPriceAbs, tick)}</span> /GPU-h
              </>
            ) : (
              ", no trade"
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
