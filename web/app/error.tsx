"use client";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main id="main">
      <div className="wrap">
        <header className="page-head">
          <span className="eyebrow">Error</span>
          <h1>This page could not be drawn</h1>
          <p className="sub">Something failed on the server while reading the data{error.digest ? ` (reference ${error.digest})` : ""}. No figures are shown rather than wrong ones.</p>
          <p>
            <button type="button" className="button" onClick={reset}>
              Read again
            </button>
          </p>
        </header>
      </div>
    </main>
  );
}
