// Button looks for links and buttons on the homepage, header and footer. Ours, written to match
// the button the adapted Ruixen UI components expect (`components/ui/button` in shadcn).
import { cn } from "@/lib/utils.ts";

export type ButtonVariant = "primary" | "secondary" | "ghost";

export function buttonClass(variant: ButtonVariant = "primary", size: "sm" | "md" = "md", className?: string): string {
  return cn(
    "inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap no-underline transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
    size === "md" ? "h-10 px-5 text-sm" : "h-9 px-4 text-sm",
    variant === "primary" && "bg-primary text-primary-foreground hover:opacity-90",
    variant === "secondary" && "bg-card text-foreground ring-1 ring-border hover:bg-muted",
    variant === "ghost" && "text-muted-foreground hover:text-foreground",
    className,
  );
}
