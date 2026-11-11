"use client";
import { useState } from "react";

/** A code block with a copy button. The text is also selectable by hand. */
export function CopyBlock({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied("done");
    } catch {
      setCopied("failed");
    }
    setTimeout(() => setCopied("idle"), 2000);
  };
  return (
    <div className="copy-block">
      <pre aria-label={label} tabIndex={0}>
        <code>{text}</code>
      </pre>
      <button type="button" className="button ghost" onClick={copy} aria-live="polite">
        {copied === "done" ? "Copied" : copied === "failed" ? "Select and copy" : "Copy"}
      </button>
    </div>
  );
}
