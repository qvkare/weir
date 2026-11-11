// One door for "reduce motion". The reader's prefers-reduced-motion setting, or, for testing
// only, `?motion=reduce` in the URL: the head script then sets <html data-motion="reduce">,
// CSS switches every animation and transition off, and every scripted piece takes the same
// code path as under the real setting (its composed final frame).

type Listener = () => void;

export interface MotionQuery {
  readonly matches: boolean;
  addEventListener(type: "change", f: Listener): void;
  removeEventListener(type: "change", f: Listener): void;
}

export const MOTION_SCRIPT = `try{if(/[?&]motion=reduce(&|$)/.test(location.search))document.documentElement.setAttribute("data-motion","reduce")}catch(e){}`;

export function forcedReduce(): boolean {
  return typeof document !== "undefined" && document.documentElement.getAttribute("data-motion") === "reduce";
}

/** Like matchMedia("(prefers-reduced-motion: reduce)"), true as well under the test override. */
export function motionQuery(): MotionQuery {
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  return {
    get matches() {
      return forcedReduce() || mq.matches;
    },
    addEventListener: (t, f) => mq.addEventListener(t, f),
    removeEventListener: (t, f) => mq.removeEventListener(t, f),
  };
}

export const reducedNow = (): boolean => motionQuery().matches;

/** Runs before paint so a stored theme never flashes. Kept here, in a module that is not a client
 * component, so the server inlines the string itself and not a client reference. */
export const THEME_SCRIPT = `try{var t=localStorage.getItem("weir-theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}`;
