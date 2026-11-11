import Link from "next/link";

export default function NotFound() {
  return (
    <main id="main">
      <div className="wrap">
        <header className="page-head">
          <span className="eyebrow">404</span>
          <h1>No page at this address</h1>
          <p className="sub">
            The pages are listed in the header. <Link href="/">The index</Link> is the place to start.
          </p>
        </header>
      </div>
    </main>
  );
}
