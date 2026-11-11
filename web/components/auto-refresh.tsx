"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Re-reads the page's server data every `everySecs` and just after `at` (a phase end), so
 * reveals fill in and a cleared round appears without a reload. Pauses while the tab is hidden.
 */
export function AutoRefresh({ everySecs = 15, at, serverNow }: { everySecs?: number; at?: number | null; serverNow: number }) {
  const router = useRouter();
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const id = setInterval(refresh, everySecs * 1000);
    let once: ReturnType<typeof setTimeout> | undefined;
    if (at && at > serverNow) once = setTimeout(refresh, (at - serverNow + 3) * 1000);
    const onVisible = () => refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      if (once) clearTimeout(once);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [router, everySecs, at, serverNow]);
  return null;
}
