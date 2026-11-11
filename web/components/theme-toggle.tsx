"use client";
import { useEffect, useState } from "react";

type Theme = "system" | "light" | "dark";
const NEXT: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };
const LABEL: Record<Theme, string> = { system: "Theme follows the system", light: "Light theme", dark: "Dark theme" };

/** Cycles system, light, dark. The choice is kept in this browser only. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("system");
  useEffect(() => {
    try {
      const t = localStorage.getItem("weir-theme");
      if (t === "light" || t === "dark") setTheme(t);
    } catch {}
  }, []);
  const choose = () => {
    const t = NEXT[theme];
    const root = document.documentElement;
    const apply = () => {
      // Colour transitions are switched off for the swap, so nothing fades through a wrong colour.
      root.classList.add("theme-swap");
      if (t === "system") root.removeAttribute("data-theme");
      else root.setAttribute("data-theme", t);
      void root.offsetHeight;
      requestAnimationFrame(() => root.classList.remove("theme-swap"));
    };
    setTheme(t);
    // One cross-fade of the whole page where the browser can do it; an instant swap otherwise.
    const vt = (document as Document & { startViewTransition?: (cb: () => void) => unknown }).startViewTransition;
    if (vt && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) vt.call(document, apply);
    else apply();
    try {
      if (t === "system") localStorage.removeItem("weir-theme");
      else localStorage.setItem("weir-theme", t);
    } catch {}
  };
  return (
    <button type="button" className="icon-button" onClick={choose} aria-label={`${LABEL[theme]}. Change theme`} title={LABEL[theme]}>
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <circle cx="10" cy="10" r="7" />
        {theme === "light" ? null : <path d="M10 3a7 7 0 0 1 0 14Z" fill="currentColor" />}
        {theme === "system" ? <path d="M10 3v14" /> : null}
      </svg>
    </button>
  );
}

/** Runs before paint so a stored theme never flashes. */
export const THEME_SCRIPT = `try{var t=localStorage.getItem("weir-theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}`;
