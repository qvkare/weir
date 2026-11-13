"use client";
import { ExtLink } from "@/components/ext-link.tsx";
import { CheckIcon, CrossIcon } from "@/components/icons.tsx";
import { Empty, NotDeployed, RpcError } from "@/components/state.tsx";
import { valueOf } from "@/lib/cache.ts";
import { accountUrl, MARKET_INFO, withMarket, type MarketId } from "@/lib/config.ts";
import { type ProofData } from "@/lib/data/proof.ts";
import { fmtUsd, fmtUsdOrNone, shortHash } from "@/lib/format.ts";
import { totalsSum } from "@/lib/views.ts";

export function Contracts({ d, explorer }: { d: ProofData; explorer: string | null }) {
  if (d.contracts.length === 0) return <Empty>No market is deployed yet, so there are no contracts to list.</Empty>;
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

export function Solvency({ market, d }: { market: MarketId; d: ProofData }) {
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
              <th scope="row">{model ? "USDC deposited (model ledger)" : `USDC held by the contract (read from the token ${params.usdc})`}</th>
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
        <p style={{ fontSize: "var(--t24)" }}>
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

