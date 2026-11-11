"use client";
import { useState } from "react";
import { CheckIcon } from "./icons.tsx";

/**
 * A code block with a title bar and a copy button. Comment lines (# or //) are set in the
 * secondary ink so the commands stand out; the text copied is exactly the text shown.
 */
export function CopyBlock({ text, label, title }: { text: string; label: string; title?: string }) {
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
  const lines = text.split("\n");
  return (
    <div className="copy-block">
      <div className="copy-head">
        <span className="copy-title">{title ?? label}</span>
        <button type="button" className={`copy-button${copied === "done" ? " done" : ""}`} onClick={copy} aria-live="polite">
          {copied === "done" ? (
            <>
              <CheckIcon /> Copied
            </>
          ) : copied === "failed" ? (
            "Select and copy"
          ) : (
            "Copy"
          )}
        </button>
      </div>
      <pre aria-label={label} tabIndex={0}>
        <code>
          {lines.map((l, i) => (
            <span key={i} className={/^\s*(#|\/\/)/.test(l) ? "c" : undefined}>
              {l}
              {i < lines.length - 1 ? "\n" : ""}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}
