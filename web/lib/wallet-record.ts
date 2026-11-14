// What this browser keeps about a connected wallet, and the little the header needs of it.
// No wallet library and no network: the header (components/front/navbar.tsx) imports this on
// every page, so it stays a few functions. The test bid (lib/try-state.ts re-exports these,
// lib/wallet.ts writes the record) is the only place a wallet is connected.

/** The connected wallet (lib/wallet.ts): its account and the page's trading key. */
export const walletKey = (contractId: string): string => `weir-wallet:${contractId}`;

/** What this browser keeps about the connected wallet (lib/wallet.ts). The secret key is the
 * trading key: a function-call key on the market only, which cannot withdraw. */
export interface WalletRecord {
  version: 1;
  contractId: string;
  secretKey: string;
  publicKey: string;
  /** NEAR Connect's id of the wallet, once one was chosen. */
  walletId: string | null;
  /** The visitor's account, once the wallet has signed in. */
  accountId: string | null;
  /** `connecting`: the key is made and the wallet asked. `connected`: signed in. `setup`: the
   * setup batch was handed to the wallet; the chain says what landed. */
  phase: "connecting" | "connected" | "setup";
  since: number;
}

export function readWallet(kv: { getItem(key: string): string | null }, contractId: string): WalletRecord | null {
  try {
    const raw = kv.getItem(walletKey(contractId));
    if (!raw) return null;
    const r = JSON.parse(raw) as WalletRecord;
    return r && r.version === 1 && r.contractId === contractId && typeof r.secretKey === "string" ? r : null;
  } catch {
    return null;
  }
}

/** The connected wallet's account, without the key; null before the wallet has signed in. */
export const walletAccount = (r: WalletRecord | null): string | null => (r?.accountId && r.phase !== "connecting" ? r.accountId : null);

/** The account this browser has connected to the market, for the header; null when none, or
 * when storage cannot be read. */
export function connectedAccount(kv: { getItem(key: string): string | null } | null, contractId: string | null): string | null {
  if (!kv || !contractId) return null;
  return walletAccount(readWallet(kv, contractId));
}

/** Sent on `window` after the test bid writes or clears the record, so the header in the same tab
 * updates; other tabs hear the `storage` event. */
export const WALLET_EVENT = "weir-wallet-change";

/** Sent on `window` by the header's "Connect wallet" when the test bid is already on screen (a
 * link to the same page would not open the chooser again). */
export const CONNECT_EVENT = "weir-wallet-connect";

/** An account name short enough for the header: kept whole up to `max` characters, else cut in
 * the middle. A named account keeps its last part (`qvkare…testnet`); an implicit one (64 hex
 * characters, or 0x and 40) keeps both ends (`9f86d0818…0a08`). 14 is what the floating bar holds. */
export function shortAccount(id: string, max = 14): string {
  if (id.length <= max) return id;
  const dot = id.lastIndexOf(".");
  const tail = dot > 0 ? id.slice(dot + 1) : "";
  if (tail && tail.length <= 8 && max - tail.length - 1 >= 4) return `${id.slice(0, max - tail.length - 1).replace(/[.]+$/, "")}…${tail}`;
  const end = Math.floor((max - 1) / 3);
  return `${id.slice(0, max - 1 - end)}…${id.slice(-end)}`;
}

/** `?connect=1` on the test bid: the header's "Connect wallet" asks the view for the wallet mode
 * and its chooser. `wallet`: select the wallet mode. `open`: open the chooser (not when a wallet
 * is already connected). When the parameter is there, `replace` is handed the address without it,
 * so a reload does not open the chooser again. */
export function takeConnectRequest(href: string, connected: boolean, replace: (url: string) => void): { wallet: boolean; open: boolean } {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return { wallet: false, open: false };
  }
  if (!url.searchParams.has("connect")) return { wallet: false, open: false };
  const asked = url.searchParams.get("connect") === "1";
  url.searchParams.delete("connect");
  replace(`${url.pathname}${url.search}${url.hash}`);
  return { wallet: asked, open: asked && !connected };
}
