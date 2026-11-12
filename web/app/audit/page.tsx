import type { Metadata } from "next";
import Link from "next/link";
import { MarkdownDoc } from "@/components/markdown-doc.tsx";
import { Empty } from "@/components/state.tsx";
import { buildData } from "@/lib/build.ts";

export const metadata: Metadata = { title: "Review record", description: "The written record of the contract's review: who did it, its scope and method, every finding with its status, the risks that remain and the verdict." };

export default function AuditPage() {
  const { audit } = buildData();
  return (
    <main id="main">
      <div className="wrap">
        <header className="page-head">
          <span className="eyebrow">Review record · docs/AUDIT.md</span>
          <h1>What the review found</h1>
          <p className="sub">
            The reviewer&rsquo;s own record, as written: an AI reviewer that did not write the contract, in four passes, against specifications 0.3, 0.4, 0.5 and 0.6. It is not an audit by a security firm. The findings are summarised on <Link href="/proof#audited">Proof</Link>; the rules they refer to are in the <Link href="/spec">specification</Link>.
          </p>
        </header>
        {audit ? <MarkdownDoc text={audit} tocLabel="Parts of the record" /> : <Empty>The review record was not found at build time.</Empty>}
      </div>
    </main>
  );
}
