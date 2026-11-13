// Adapted from Ruixen UI "grouped-faq-section" (https://ruixen.com/r/grouped-faq-section.json).
// MIT, Copyright (c) 2025 Ruixen UI. Changes: native <details> instead of the Radix accordion (no
// package, works without JavaScript); answers may hold links; heading in the site's two-tone form.
import type { ReactNode } from "react";

export interface FaqGroup {
  title: string;
  items: { question: string; answer: ReactNode }[];
}

export function GroupedFaq({ groups }: { groups: FaqGroup[] }) {
  return (
    <div className="space-y-10">
      {groups.map((g) => (
        <div key={g.title} className="space-y-3">
          <h3 className="text-lg font-medium text-foreground">{g.title}</h3>
          <div>
            {g.items.map((it) => (
              <details key={it.question} className="group rounded-xl px-5 py-1 open:bg-card open:shadow-sm open:ring-1 open:ring-border">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 border-b border-border py-4 text-base text-foreground group-open:border-transparent [&::-webkit-details-marker]:hidden">
                  {it.question}
                  <span aria-hidden="true" className="text-muted-foreground transition-transform group-open:rotate-45">
                    +
                  </span>
                </summary>
                <div className="pb-4 text-sm text-muted-foreground">{it.answer}</div>
              </details>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
