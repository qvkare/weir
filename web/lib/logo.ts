// The mark's geometry (DESIGN section 3). "Crew cut": a heatsink seen end-on, fins standing on a
// solid base, two arched eyes punched through the base. One colour, always currentColor.
// components/logo.tsx draws it, tools/og-image.ts rasterises it, brand/*.svg are exports.
//
//   full   48 grid, five fins: anything drawn 32 px tall or more.
//   small  24 grid, three fins and larger eyes, every edge on a whole unit: under 32 px, the
//          favicon and the header. Pixel-exact at 24 and 48 px; still a face at 16 px.

const r1 = (n: number) => +n.toFixed(2);

/** A fin: square foot on the base line, rounded top. */
function fin(x: number, top: number, w: number, foot: number, r: number) {
  return `M${r1(x)} ${foot}V${r1(top + r)}A${r} ${r} 0 0 1 ${r1(x + r)} ${top}H${r1(x + w - r)}A${r} ${r} 0 0 1 ${r1(x + w)} ${r1(top + r)}V${foot}Z`;
}

/** The base: square top where the fins stand, rounded lower corners. */
function base(x0: number, x1: number, top: number, bottom: number, r: number) {
  return `M${x0} ${top}H${x1}V${r1(bottom - r)}A${r} ${r} 0 0 1 ${r1(x1 - r)} ${bottom}H${r1(x0 + r)}A${r} ${r} 0 0 1 ${x0} ${r1(bottom - r)}Z`;
}

/** An eye: an arch, flat at the bottom, drawn the other way round so even-odd punches it out. */
function eye(x: number, w: number, top: number, bottom: number) {
  const r = w / 2;
  return `M${r1(x)} ${bottom}H${r1(x + w)}V${r1(top + r)}A${r} ${r} 0 0 0 ${r1(x)} ${r1(top + r)}Z`;
}

// Full: fins 4.4 wide on a 7.9 pitch from x = 6 (gaps 3.5), base 36 wide with 7-unit corners,
// eyes 5.4 wide, centred 6.7 either side of the axis x = 24. Fins stop exactly on the base line
// (y = 23) so nothing overlaps and the even-odd rule only touches the eyes.
const FULL_FINS = [0, 1, 2, 3, 4].map((i) => fin(6 + i * 7.9, 5, 4.4, 23, 1.2)).join("");
const FULL = FULL_FINS + base(6, 42, 23, 43, 7) + eye(14.6, 5.4, 27.6, 36) + eye(28, 5.4, 27.6, 36);

// Small: three fins 4 wide on a 7 pitch (gaps 3), base 18 wide with 3.5 corners, eyes 3 wide.
// Optical correction: the eyes sit one unit lower than centre on the base, so the face reads
// as looking up at the fins, and they stay 3 units apart, never closer than a fin gap.
const SMALL_FINS = [3, 10, 17].map((x) => fin(x, 2, 4, 10, 1)).join("");
const SMALL = SMALL_FINS + base(3, 21, 10, 21, 3.5) + eye(7, 3, 13.5, 18) + eye(14, 3, 13.5, 18);

/** The full mark without its eyes, and the eyes, for the one place the face moves (the floor). */
export const MARK_PARTS = {
  body: FULL_FINS + base(6, 42, 23, 43, 7),
  eyes: [
    { x: 14.6, w: 5.4, top: 27.6, bottom: 36 },
    { x: 28, w: 5.4, top: 27.6, bottom: 36 },
  ],
} as const;

/** An arch-shaped eye as a path, at any height (for blinking). */
export const eyePath = (x: number, w: number, top: number, bottom: number) => eye(x, w, Math.min(top, bottom - w / 2), bottom);

export const MARK = {
  full: { viewBox: "0 0 48 48", crop: "5 4 38 40", d: FULL, grid: 48 },
  small: { viewBox: "0 0 24 24", crop: "2 1 20 21", d: SMALL, grid: 24 },
} as const;

/** Under this rendered height (px) the small cut is used. */
export const SMALL_BELOW = 32;
