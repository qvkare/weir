"use client";
import type { ReactNode } from "react";
import { BundleVerifier } from "@/components/bundle-verifier.tsx";
import { ExtLink } from "@/components/ext-link.tsx";
import { CheckIcon, CrossIcon } from "@/components/icons.tsx";
import { LiveBar, useLive } from "@/components/live.tsx";
import { Empty, NotDeployed, RpcError } from "@/components/state.tsx";
import { valueOf } from "@/lib/cache.ts";
import { clientReader } from "@/lib/client-source.ts";
import { accountUrl, MARKET_INFO, withMarket, type MarketId } from "@/lib/config.ts";
import { loadProof, type ContractRow, type ProofData } from "@/lib/data/proof.ts";
import { fmtUsd, fmtUsdOrNone, shortHash } from "@/lib/format.ts";
import type { SiteConfig } from "@/lib/site-config.ts";
import { totalsSum } from "@/lib/views.ts";

interface Props {
  cfg: SiteConfig;
  market: MarketId;
  rows: ContractRow[];
  initial: ProofData;
  recorded: { file: string; text: string; bucket: number | null } | null;
  recordedNote: ReactNode;
  audited: ReactNode;
  sandbox: ReactNode;
}

/** The sections of /proof that read the chain, read once when the page opens, with the static ones between them. */
export function ProofLive({ cfg, market, rows, initial, recorded, recordedNote, audited, sandbox }: Props) {
  const [st, retry] = useLive<ProofData>({
    initial,
    initialAt: cfg.builtAt * 1000,
    mode: cfg.mode,
    load: async () => {
      const readers = new Map<MarketId, ReturnType<typeof clientReader>>();
      const readerOf = (m: MarketId) => readers.get(m) ?? (readers.set(m, clientReader(cfg, m)), readers.get(m)!);
      const d = await loadProof(rows, readerOf, market);
      const failed = [d.params, d.totals].find((r) => r && !r.ok);
      if (failed && !failed.ok) throw new Error(failed.error);
      return d;
    },
    pollSecs: 0,
  });
  const d = st.data;
  const params = d.params ? valueOf(d.params) : null;
  const bar = <LiveBar st={st} mode={cfg.mode} builtAt={cfg.builtAt} polls="Read once when the page opens; it does not poll." retry={retry} />;
  // The verifier fetches every bundle; it starts once, on the figures this browser read (or on the
  // build's when the read failed or there is no chain).
  const verifyNow = cfg.mode !== "chain" || st.from === "live" || !!st.error;
  return (
    <>
      <div style={{ marginTop: 24 }}>{bar}</div>
      <section className="section" id="contracts" aria-labelledby="contracts-h">
        <div className="section-head">
          <h2 id="contracts-h">Contracts</h2>
          <span className="note">Keys and code hash. A contract account with no keys cannot change its code.</span>
        </div>
        <Contracts d={d} explorer={cfg.explorer} />
      </section>

      <section className="section" id="audited" aria-labelledby="audited-h">
        <div className="section-head">
          <h2 id="audited-h">Audited</h2>
          <span className="note">Four passes by an AI reviewer, not an audit firm · <a href="/audit">the full record</a></span>
        </div>
        {audited}
      </section>

      <section className="section" id="sandbox" aria-labelledby="sandbox-h">
        <div className="section-head">
          <h2 id="sandbox-h">Contract against the engine</h2>
          <span className="note">integration/RESULTS.md</span>
        </div>
        {sandbox}
      </section>

      <section className="section" id="solvency" aria-labelledby="solvency-h">
        <div className="section-head">
          <h2 id="solvency-h">Solvency, {MARKET_INFO[market].name} market</h2>
          <span className="note">get_totals against the contract&rsquo;s USDC balance</span>
        </div>
        <Solvency market={market} d={d} />
      </section>

      <section className="section" id="verifier" aria-labelledby="verifier-h">
        <div className="section-head">
          <h2 id="verifier-h">Bundle verifier</h2>
          <span className="note">SHA-256 by SubtleCrypto in this browser</span>
        </div>
        {d.kind === "none" ? <NotDeployed market={market} what="print to check" /> : !params ? <RpcError read={d.params ?? { ok: false, error: "not read", lastGood: null }} href="/proof#verifier" model={d.kind === "model"} /> : null}
        {recordedNote}
        {verifyNow ? (
          <div style={{ marginTop: 12 }}>
            <BundleVerifier key={d.prints.map((p) => p.bucket).join(",")} prints={params ? d.prints : []} bundlesBase={params ? cfg.bundlesBase : null} recorded={recorded} tick={params?.tick ?? 0} model={d.kind === "model"} />
          </div>
        ) : (
          <p className="small muted">Reading the last prints before checking them&hellip;</p>
        )}
      </section>
    </>
  );
}

function Contracts({ d, explorer }: { d: ProofData; explorer: string | null }) {
  if (d.contracts.length === 0) return <Empty>No market is deployed yet, so there are no contracts to list. deployments.json has an empty markets list.</Empty>;
  const data = d.contracts;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">Market</th>
            <th scope="col">Account</th>
            <th scope="col" className="collapse-sm">Role</th>
            <th scope="col">Code hash</th>
            <th scope="col" className="num">Keys remaining</th>
          </tr>
        </thead>
        <tbody>
          {data.map((r) => {
            const keys = r.keys ? valueOf(r.keys) : null;
            const full = keys?.filter((k) => k.permission === "FullAccess").length ?? 0;
            const url = r.kind === "chain" ? accountUrl(explorer, r.account) : null;
            const model = r.kind === "model";
            return (
              <tr key={`${r.market}-${r.account}`}>
                <td>{MARKET_INFO[r.market].name}</td>
                <td className="mono">{url ? <ExtLink href={url}>{r.account}</ExtLink> : r.account}</td>
                <td className="collapse-sm">{r.role}</td>
                <td className="mono">{model ? <span className="muted">model, no chain account</span> : r.acct && valueOf(r.acct) ? shortHash(valueOf(r.acct)!.codeHash, 6, 4) : <span className="bad">read failed</span>}</td>
                <td className="num">
                  {model ? (
                    <span className="muted">model</span>
                  ) : keys ? (
                    keys.length === 0 ? (
                      <span className="ok"><CheckIcon /> 0, locked</span>
                    ) : (
                      <span className={r.role.startsWith("Weir") ? "flag" : undefined}>
                        {keys.length} ({full} full access)
                      </span>
                    )
                  ) : (
                    <span className="bad">read failed</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Solvency({ market, d }: { market: MarketId; d: ProofData }) {
  if (d.kind === "none") return <NotDeployed market={market} what="balance" />;
  const params = d.params ? valueOf(d.params) : null;
  const totalsR = d.totals;
  const totals = totalsR ? valueOf(totalsR) : null;
  if (!params || !totals || !totalsR) return <RpcError read={d.params && !d.params.ok ? d.params : totalsR ?? { ok: false, error: "not read", lastGood: null }} href={`${withMarket("/proof", market)}#solvency`} model={d.kind === "model"} />;
  const balanceR = d.balance ?? { ok: false as const, error: "not read", lastGood: null };
  const balance = valueOf(balanceR);
  const sum = totalsSum(totals);
  const bal = balance !== null && /^\d+$/.test(balance) ? BigInt(balance) : null;
  // Burned dollars stay in the contract's token balance and belong to nobody, so the balance
  // must equal all five terms (SPEC 11, invariant 1); a surplus would be an unexplained deposit.
  const ok = sum !== null && bal !== null && bal >= sum;
  const model = d.kind === "model";
  const terms: [string, string, string][] = [
    ["Free balances", totals.free, "free"],
    ["Commit locks", totals.locked, "locked"],
    ["Open sets x band", totals.sets_backing, "sets_backing"],
    ["Not yet redeemed", totals.unredeemed, "unredeemed"],
    ["Burned: forfeits and commit fees, owned by nobody", totals.burned, "burned"],
  ];
  return (
    <div className="grid-2">
      <div className="table-wrap">
        <table>
          <caption>SPEC 11, invariant 1: the USDC held must cover these five terms. Burned dollars stay in the contract and are counted, so nobody can claim them.</caption>
          <tbody>
            {terms.map(([label, v, key]) => (
              <tr key={key}>
                <th scope="row">
                  {label} <code className="tiny muted">{key}</code>
                </th>
                <td className="num">{fmtUsdOrNone(v)}</td>
              </tr>
            ))}
            <tr className="ink">
              <th scope="row">Owed, total</th>
              <td className="num">{fmtUsd(sum)}</td>
            </tr>
            <tr>
              <th scope="row">{model ? "USDC deposited (model ledger)" : `USDC held (ft_balance_of on ${params.usdc})`}</th>
              <td className="num">{bal === null ? <span className="bad">read failed</span> : fmtUsd(bal)}</td>
            </tr>
            <tr>
              <th scope="row">Surplus</th>
              <td className="num">{bal !== null && sum !== null ? fmtUsdOrNone(bal - sum) : "no data"}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="stack">
        <p style={{ fontSize: "var(--t21)" }}>
          {bal === null || sum === null ? (
            <span className="flag">Unverified: the balance could not be read.</span>
          ) : ok ? (
            <span className="ok"><CheckIcon /> Covered.</span>
          ) : (
            <span className="bad"><CrossIcon /> Not covered.</span>
          )}
        </p>
        <p className="small muted">
          {model ? "Model figures: the balance is the model's own count of deposits, not a token contract." : "Both reads come from the same RPC within a few seconds; a deposit landing between them can show as surplus."}
        </p>
        {!balanceR.ok ? <p className="tiny bad">{balanceR.error}</p> : null}
      </div>
    </div>
  );
}

