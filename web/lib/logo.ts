// The mark's two masters (geometry only; components/logo.tsx draws them, tools/og-image.ts rasterises them).
export const MARK = {
  wide: { viewBox: "0 0 32 24", crop: "0 4.75 32 14.25", d: "M1 6H8.5L12.25 18.5L16 6L19.75 18.5L23.5 6H31", stroke: 2.5 },
  compact: { viewBox: "0 0 24 24", crop: "0 0 24 24", d: "M1 7H6.5L9.25 18L12 7L14.75 18L17.5 7H23", stroke: 3 },
} as const;
