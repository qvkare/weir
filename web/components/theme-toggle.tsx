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
    setTheme(t);
    if (t === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", t);
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
