// A small client for the NEAR Intents 1Click API, for quotes only: how much USDC on NEAR a
// deposit of USDC on another chain would become. A dry quote moves nothing and needs no key.
// Intents runs on mainnet only; there is no testnet.
/** The subset of `fetch` the client uses, so tests can pass a fake. */
export type HttpFetch = (
  url: string,
  init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string; signal: AbortSignal },
) => Promise<{ status: number; text(): Promise<string> }>;

export const ONECLICK_URL = "https://1click.chaindefuser.com";

/** USDC on each origin chain, and on NEAR, as 1Click asset ids. */
export const USDC = {
  base: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  arb: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
  eth: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
  sol: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
  near: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
} as const;

export type Chain = keyof typeof USDC;
export const USDC_DECIMALS = 6;

/** Well-formed refund addresses for dry quotes only. Nobody is known to control them, so
 * they must never be used for a real deposit. (The API rejects the 0x...dEaD burn address.)
 * The recipient, by contrast, must be an existing NEAR mainnet account or a 64-hex implicit
 * account: an unknown named account makes the API answer "Internal server error". */
export const PLACEHOLDER_REFUND: Record<Chain, string> = {
  base: "0x2222222222222222222222222222222222222222",
  arb: "0x2222222222222222222222222222222222222222",
  eth: "0x2222222222222222222222222222222222222222",
  sol: "3JF3sEqM796hk5WFqA6EtmEwJQ9quALszsfJyvXNQKy3",
  near: "placeholder-refund.near",
};

export interface QuoteRequest {
  dry: boolean;
  swapType: "EXACT_INPUT";
  /** Basis points. */
  slippageTolerance: number;
  originAsset: string;
  depositType: "ORIGIN_CHAIN";
  destinationAsset: string;
  /** Base units of the origin asset, as a decimal string. */
  amount: string;
  refundTo: string;
  refundType: "ORIGIN_CHAIN";
  recipient: string;
  recipientType: "DESTINATION_CHAIN";
  /** ISO 8601. */
  deadline: string;
}

export interface Quote {
  amountIn: string;
  amountInFormatted: string;
  amountOut: string;
  amountOutFormatted: string;
  minAmountOut: string;
  timeEstimate: number;
  minAmountIn?: string;
  refundFee?: string;
  withdrawFee?: string;
  amountInUsd?: string;
  amountOutUsd?: string;
  deadline?: string;
  depositAddress?: string;
}

export interface QuoteResponse {
  timestamp: string;
  signature: string;
  quoteRequest: QuoteRequest;
  quote: Quote;
}

export interface TokenInfo {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price: number;
  priceUpdatedAt: string;
  contractAddress?: string;
}

/** `amount` in whole USDC ("20", "12.5") to base units, exactly. */
export function usdcUnits(amount: string): string {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(amount.trim());
  if (!m) throw new Error(`amount must be a USDC amount with at most ${USDC_DECIMALS} decimals`);
  return (BigInt(m[1]!) * 10n ** 6n + BigInt((m[2] ?? "").padEnd(6, "0"))).toString();
}

/** A dry EXACT_INPUT quote request for moving USDC from `from` to USDC on NEAR. */
export function usdcToNear(opts: {
  from: Exclude<Chain, "near">;
  /** Base units. */
  amount: string;
  recipient: string;
  refundTo?: string;
  slippageBps?: number;
  now?: Date;
  deadlineSecs?: number;
}): QuoteRequest {
  const now = opts.now ?? new Date();
  return {
    dry: true,
    swapType: "EXACT_INPUT",
    slippageTolerance: opts.slippageBps ?? 100,
    originAsset: USDC[opts.from],
    depositType: "ORIGIN_CHAIN",
    destinationAsset: USDC.near,
    amount: opts.amount,
    refundTo: opts.refundTo ?? PLACEHOLDER_REFUND[opts.from],
    refundType: "ORIGIN_CHAIN",
    recipient: opts.recipient,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(now.getTime() + (opts.deadlineSecs ?? 3600) * 1000).toISOString(),
  };
}

export class IntentsClient {
  readonly baseUrl: string;
  readonly #fetch: HttpFetch;
  readonly #timeoutMs: number;

  constructor(opts: { baseUrl?: string; fetch?: HttpFetch; timeoutMs?: number } = {}) {
    this.baseUrl = opts.baseUrl ?? ONECLICK_URL;
    this.#fetch = opts.fetch ?? ((url, init) => fetch(url, init));
    this.#timeoutMs = opts.timeoutMs ?? 15_000;
  }

  /** `POST /v0/quote`. Refuses anything but a dry quote: this client never starts a swap. */
  quote(req: QuoteRequest): Promise<QuoteResponse> {
    if (!req.dry) throw new Error("this client only asks for dry quotes");
    return this.#request("POST", "/v0/quote", JSON.stringify(req));
  }

  /** `GET /v0/tokens`. */
  tokens(): Promise<TokenInfo[]> {
    return this.#request("GET", "/v0/tokens");
  }

  async #request<T>(method: "GET" | "POST", path: string, body?: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const headers: Record<string, string> = { accept: "application/json" };
      if (body !== undefined) headers["content-type"] = "application/json";
      const res = await this.#fetch(`${this.baseUrl}${path}`, { method, headers, body, signal: controller.signal });
      const text = await res.text();
      if (res.status < 200 || res.status >= 300) throw new Error(`1Click ${path} answered HTTP ${res.status}: ${text.slice(0, 300)}`);
      return JSON.parse(text) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The numbers a person deciding to bridge cares about, in whole USDC. */
export function summarize(res: QuoteResponse): { amountIn: string; amountOut: string; minAmountOut: string; seconds: number } {
  const whole = (units: string) => {
    const v = BigInt(units);
    return `${v / 1_000_000n}.${(v % 1_000_000n).toString().padStart(6, "0")}`;
  };
  return {
    amountIn: whole(res.quote.amountIn),
    amountOut: whole(res.quote.amountOut),
    minAmountOut: whole(res.quote.minAmountOut),
    seconds: res.quote.timeEstimate,
  };
}
