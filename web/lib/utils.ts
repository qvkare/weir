// `cn`: joins class names and lets a later Tailwind utility override an earlier one. The helper
// the adapted Ruixen UI components expect (components/front, components/ui).
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
