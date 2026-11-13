// The wallet's browser side, loaded by components/front/app/try-view.tsx with a dynamic import
// when a visitor chooses "Connect a NEAR wallet". It makes the NEAR Connect selector
// (`@hot-labs/near-connect`, itself a dynamic import: it touches `window` and IndexedDB when
// created), the chain views lib/wallet.ts reads, and the guest that trades with the stored key.
//
// The selector reads our own copy of the wallet manifest (public/wallets/manifest.json: only the
// wallets that work on testnet, icons inlined), not the one on GitHub. Each wallet's script still
// loads from its publisher when it is chosen (lib/headers.ts lists the origins).
import { Guest, type GuestDeps, type GuestEvent } from "@weir/chain/guest";
import { isUnknownAccount } from "@weir/chain/faucet";
import { NearRpc } from "@weir/chain/near";
import { Token } from "@weir/chain/token";
import { KeyPair, secretKeyFromSeed } from "@weir/chain/tx";
import { ChainWeir } from "@weir/chain/weir";
import { guestStorage, type KV } from "./try-state.ts";
import { guestConfig, type TryTarget } from "./try-run.ts";
import { walletGuestKey, WalletSession, type ChainReads, type ConnectorLike } from "./wallet.ts";

/** Our pinned manifest, served by this site. */
export const MANIFEST_PATH = "/wallets/manifest.json";
/** The wallets the chooser offers, in its order. */
export const WALLET_IDS = ["meteor-wallet", "intear-wallet", "mynearwallet", "near-cli"] as const;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const fetchFn: GuestDeps["fetch"] = (url, init) => fetch(url, init);

let connectorPromise: Promise<ConnectorLike> | null = null;

/** The NEAR Connect selector on testnet, made once per page. */
export function nearConnector(rpcUrls: readonly string[]): Promise<ConnectorLike> {
  connectorPromise ??= import("@hot-labs/near-connect").then(({ NearConnector }) => {
    const fastnear = rpcUrls.filter((u) => /fastnear/.test(u));
    const c = new NearConnector({
      network: "testnet",
      manifest: new URL(MANIFEST_PATH, window.location.origin).toString(),
      // Wallets that read the chain themselves (NEAR CLI's hash check) use the site's RPC.
      providers: { testnet: [...fastnear, ...rpcUrls.filter((u) => !fastnear.includes(u))] },
      autoConnect: false,
      // The selector's footer links to a mainnet wallet page; the view says how to get a testnet account.
      footerBranding: null,
    });
    return c as unknown as ConnectorLike;
  });
  return connectorPromise;
}

function chainReads(t: TryTarget, usdcId: string): ChainReads {
  const rpc = new NearRpc({ urls: t.rpcUrls, fetch: fetchFn, now: Date.now, sleep });
  const weir = new ChainWeir({ rpc, contractId: t.contractId, usdcId });
  const token = new Token(rpc, usdcId);
  return {
    accountExists: async (id) => {
      try {
        await rpc.viewAccount(id);
        return true;
      } catch (e) {
        if (isUnknownAccount(e)) return false;
        throw e;
      }
    },
    accessKey: async (id, pk) => {
      try {
        return (await rpc.viewAccessKey(id, pk)).permission;
      } catch (e) {
        if (/UNKNOWN_ACCESS_KEY|access key .*does not exist|UNKNOWN_ACCOUNT/i.test(`${(e as { code?: string }).code ?? ""} ${e instanceof Error ? e.message : String(e)}`)) return null;
        throw e;
      }
    },
    weirBalance: async (id) => (await weir.get_account({ account_id: id }))?.balance ?? null,
    tokenBalance: async (id) => (await token.balanceOf(id)) ?? "0",
  };
}

/** The wallet session for this market: storage, the selector (made when first needed) and chain views. */
export async function walletSession(t: TryTarget, kv: KV): Promise<WalletSession> {
  const usdcId = t.usdcId ?? (await new ChainWeir({ rpc: new NearRpc({ urls: t.rpcUrls, fetch: fetchFn, now: Date.now, sleep }), contractId: t.contractId }).get_params({})).usdc;
  return new WalletSession({
    contractId: t.contractId,
    usdcId,
    kv,
    connector: () => nearConnector(t.rpcUrls),
    chain: chainReads(t, usdcId),
    newKey: async () => {
      const secretKey = secretKeyFromSeed(crypto.getRandomValues(new Uint8Array(32)));
      return { secretKey, publicKey: (await KeyPair.fromString(secretKey)).publicKeyString };
    },
    now: Date.now,
    sleep,
  });
}

/** The guest that trades for the wallet's account with the stored trading key; its state is kept
 * apart from the throwaway guest's, so both can live in one browser. */
export function openWalletGuest(t: TryTarget, kv: KV, account: { accountId: string; secretKey: string }, onEvent: (e: GuestEvent) => void): Promise<Guest> {
  const store = guestStorage(kv);
  const deps: GuestDeps = {
    fetch: fetchFn,
    now: Date.now,
    sleep,
    randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
    storage: { get: store.get, set: store.set },
    onEvent,
  };
  return Guest.forAccount({ ...guestConfig(t), storageKey: walletGuestKey(t.contractId) }, deps, account);
}
