import type { ReactNode } from "react";
import { NO_DATA } from "@/lib/format.ts";
import { LiveValue } from "./live-value.tsx";

/**
 * The only way a figure renders: a label, a value with its unit set apart, and where it came
 * from. A value that is missing prints "no data"; a modelled one says so in the source line.
 */
export function Figure({
  label,
  value,
  unit,
  source,
  display = false,
  live = false,
  className,
}: {
  label: ReactNode;
  value: string | null;
  unit?: string;
  source?: ReactNode;
  display?: boolean;
  /** The value comes from live data: settle in briefly when it changes after a refresh. */
  live?: boolean;
  className?: string;
}) {
  const missing = value === null || value === NO_DATA;
  return (
    <div className={`figure${display ? " display" : ""}${className ? ` ${className}` : ""}`}>
      <span className="label">{label}</span>
      <span className="value">
        {missing ? <span className="muted">{NO_DATA}</span> : live ? <LiveValue text={value}>{value}</LiveValue> : value}
        {!missing && unit ? <span className="unit">{unit}</span> : null}
      </span>
      {source ? <span className="source">{source}</span> : null}
    </div>
  );
}

/** Splits "$2.31 /GPU-h" into value and unit for Figure. */
export function priceParts(text: string): { value: string; unit?: string } {
  const i = text.indexOf(" /");
  return i < 0 ? { value: text } : { value: text.slice(0, i), unit: text.slice(i) };
}
