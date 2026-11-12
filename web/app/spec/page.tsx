import type { Metadata } from "next";
import { MarkdownDoc } from "@/components/markdown-doc.tsx";
import { Empty } from "@/components/state.tsx";
import { buildData } from "@/lib/build.ts";

export const metadata: Metadata = { title: "Specification", description: "The Weir specification, the source of truth the contract and the engine are written from." };

export default function SpecPage() {
  const { spec, specVersion } = buildData();
  return (
    <main id="main">
      <div className="wrap">
        <header className="page-head">
          <span className="eyebrow">Specification{specVersion ? ` · version ${specVersion}` : ""}</span>
          <h1>The rules, as written</h1>
          <p className="sub">The specification, the source of truth. The contract and the engine are written from it independently and must agree on every number; where code and this text differ, the code is wrong.</p>
        </header>
        {spec ? <MarkdownDoc text={spec} /> : <Empty>The specification is not available in this version of the page.</Empty>}
      </div>
    </main>
  );
}
