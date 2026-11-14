"use client";
// "Connect a NEAR wallet" on the test bid (try-view.tsx): the connect button, the account, the
// one setup approval and disconnect. The wallet code (lib/wallet-run.ts, and NEAR Connect inside
// it) is a dynamic import made when the visitor presses Connect, or when this browser already
// holds a connected wallet; nothing of it loads for a guest.
import { useCallback, useEffect, useRef, useState } from "react";
import { buttonClass } from "@/components/ui/button.ts";
import { ExternalIcon } from "@/components/icons.tsx";
import { fmtUsdShort } from "@/lib/format.ts";
import { localKV, readWallet, walletAccount, type PlanView, type WalletRecord } from "@/lib/try-state.ts";
import { WALLET_EVENT } from "@/lib/wallet-record.ts";
import { cn } from "@/lib/utils.ts";
import type { TryTarget } from "@/lib/try-run.ts";
import type { WalletSession, WalletStatus } from "@/lib/wallet.ts";

const EXPLORER = "https://testnet.nearblocks.io";

export interface WalletView {
  /** The account once the wallet has signed in. */
  accountId: string | null;
  status: WalletStatus | null;
  /** Key on chain, registered, and a free balance that covers the order on screen. */
  ready: boolean;
  /** Why the bid button is off while not ready, in one sentence. */
  reason: string;
  busy: "connect" | "setup" | "check" | "disconnect" | null;
  error: { kind: string; message: string } | null;
  connect(): void;
  setup(): void;
  disconnect(open: boolean): void;
  /** Reads the chain again (after a bid: the balance moved). */
  refresh(): void;
}

/** A failure as the panel shows it: a WalletError's plain text, else one plain sentence. */
function shown(e: unknown): { kind: string; message: string } {
  if (e && typeof e === "object" && "kind" in e && (e as { name?: string }).name === "WalletError") {
    return { kind: String((e as { kind: unknown }).kind), message: String((e as { message?: unknown }).message ?? "") };
  }
  return { kind: "rpc", message: "The NEAR RPC did not answer. Press the button again; nothing is sent twice." };
}

/** The wallet's state for the view. `enabled` is false in guest mode: the hook then does nothing. */
export function useWallet(enabled: boolean, target: TryTarget | null, plan: PlanView | null): WalletView {
  const [rec, setRec] = useState<WalletRecord | null>(null);
  const [status, setStatus] = useState<WalletStatus | null>(null);
  const [busy, setBusy] = useState<WalletView["busy"]>(null);
  const [error, setError] = useState<WalletView["error"]>(null);
  const session = useRef<Promise<WalletSession> | null>(null);
  const maxNeed = plan?.order ? BigInt(plan.order.maxNeed) : null;
  const need = useRef(maxNeed);
  need.current = maxNeed;

  const open = useCallback((): Promise<WalletSession> => {
    const kv = localKV();
    if (!target || !kv) return Promise.reject(new Error("no storage"));
    return (session.current ??= import("@/lib/wallet-run.ts").then((m) => m.walletSession(target, kv)));
  }, [target]);
  const run = useCallback(
    async (kind: NonNullable<WalletView["busy"]>, f: (s: WalletSession) => Promise<WalletStatus | void>) => {
      setBusy(kind);
      setError(null);
      try {
        const s = await open();
        const r = await f(s);
        if (r) setStatus(r);
      } catch (e) {
        setError(shown(e));
        // What did land is on the chain: read it, so the button offers only what is missing.
        if (kind === "setup") {
          try {
            setStatus(await (await open()).check(need.current));
          } catch {
            // The error above already says what to do.
          }
        }
      } finally {
        const kv = localKV();
        setRec(kv && target ? readWallet(kv, target.contractId) : null);
        setBusy(null);
        // The header shows the connected account; tell it the record may have changed.
        window.dispatchEvent(new Event(WALLET_EVENT));
      }
    },
    [open, target],
  );

  // On open: a wallet this browser already connected is read from the chain.
  useEffect(() => {
    if (!enabled || !target) return;
    const kv = localKV();
    const r = kv ? readWallet(kv, target.contractId) : null;
    setRec(r);
    if (walletAccount(r)) void run("check", (s) => s.check(need.current));
  }, [enabled, target, run]);

  const accountId = walletAccount(rec);
  const covered = status && (maxNeed === null || status.balance >= maxNeed);
  const ready = !!(enabled && accountId && status?.ready && covered);
  const reason = !accountId
    ? "Connect a wallet first."
    : !status
      ? "Reading your account."
      : !status.keyOnChain || !status.registered
        ? "Approve the setup in your wallet first."
        : "Add test dollars first: the free balance does not cover this order.";

  return {
    accountId,
    status,
    ready,
    reason,
    busy,
    error,
    connect: () => void run("connect", (s) => s.connect(need.current)),
    setup: () => void run("setup", (s) => s.setup(need.current)),
    disconnect: (openBid: boolean) => {
      const msg = openBid
        ? "Disconnect? Your sealed bid would stay unrevealed and lose 1% of its lock. The trading key is deleted from this browser."
        : "Disconnect? The trading key is deleted from this browser. It stays on your account, limited to this market, until you remove it in your wallet.";
      if (!window.confirm(msg)) return;
      void run("disconnect", async (s) => {
        await s.disconnect();
        setStatus(null);
      });
    },
    refresh: () => {
      if (accountId) void run("check", (s) => s.check(need.current));
    },
  };
}

function AccountLink({ id }: { id: string }) {
  return (
    <a href={`${EXPLORER}/address/${encodeURIComponent(id)}`} target="_blank" rel="noopener noreferrer" className="break-all font-mono">
      {id} <ExternalIcon />
      <span className="sr-only"> (account on nearblocks, opens in a new tab)</span>
    </a>
  );
}

/** What the one setup approval does, in words. */
function setupWords(s: WalletStatus): string {
  const parts: string[] = [];
  if (!s.keyOnChain) parts.push("adds the trading key to your account");
  if (!s.registered) parts.push("registers you with the market (0.02 NEAR)");
  if (s.deposit > 0n) parts.push(`mints and deposits ${fmtUsdShort(s.deposit)} in test dollars`);
  if (parts.length === 0) return "";
  const last = parts.pop()!;
  return `One approval in your wallet ${parts.length ? `${parts.join(", ")} and ${last}` : last}.`;
}

export function WalletPanel({ w, running, openBid }: { w: WalletView; running: boolean; openBid: boolean }) {
  const disabled = running || w.busy !== null;
  const btn = cn(buttonClass("primary", "md"), "cursor-pointer border-0 font-sans disabled:cursor-not-allowed disabled:opacity-50");
  const s = w.status;
  return (
    <div className="mt-5 rounded-lg bg-background/60 px-4 py-4 ring-1 ring-border">
      {!w.accountId ? (
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <button type="button" className={btn} disabled={disabled} onClick={w.connect}>
              {w.busy === "connect" ? "Waiting for the wallet" : "Connect a NEAR wallet"}
            </button>
            <p className="m-0 text-sm text-muted-foreground">Meteor, Intear, MyNearWallet or NEAR CLI, on NEAR testnet.</p>
          </div>
          <p className="m-0 mt-3 max-w-[68ch] text-xs text-muted-foreground">No testnet account yet? Meteor Wallet makes one: switch it to testnet, then create an account.</p>
        </>
      ) : (
        <>
          <p className="m-0 text-sm text-foreground">
            Connected: <AccountLink id={w.accountId} />
            {s?.walletName ? <span className="text-muted-foreground"> with {s.walletName}</span> : null}
          </p>
          <p className="m-0 mt-2 max-w-[68ch] text-sm text-muted-foreground">
            This page holds a trading key for your account that can commit, reveal, clear, settle and redeem in this market, and cannot withdraw or move your tokens.
          </p>
          {s && !w.ready ? (
            <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
              <button type="button" className={btn} disabled={disabled} onClick={w.setup}>
                {w.busy === "setup" ? "Waiting for the wallet" : w.error?.kind === "refunded" ? "Deposit again" : s.keyOnChain && s.registered ? "Add test dollars" : "Approve the setup in your wallet"}
              </button>
              <p className="m-0 max-w-[52ch] text-sm text-muted-foreground">{setupWords(s)}</p>
            </div>
          ) : s && w.ready ? (
            <p className="m-0 mt-3 text-sm text-foreground">
              Set up. Free balance in the market <span className="font-mono tabular-nums">{fmtUsdShort(s.balance)}</span>.
            </p>
          ) : (
            <p className="m-0 mt-3 text-sm text-muted-foreground" role="status">
              Reading your account.
            </p>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-3">
            <button type="button" className={cn(buttonClass("ghost", "sm"), "cursor-pointer border-0 bg-transparent px-0 font-sans disabled:cursor-not-allowed disabled:opacity-50")} disabled={disabled} onClick={() => w.disconnect(openBid)}>
              Disconnect
            </button>
            <span className="text-xs text-muted-foreground">{running ? "Not while a call is in flight." : "Deletes the trading key from this browser and signs the wallet out."}</span>
          </div>
        </>
      )}
      {w.error ? (
        <div className="state error mt-4" role="alert">
          <p>{w.error.message}</p>
        </div>
      ) : null}
    </div>
  );
}
