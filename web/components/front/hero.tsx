// Adapted from Ruixen UI "structured-hero-section" (https://ruixen.com/r/structured-hero-section.json).
// MIT, Copyright (c) 2025 Ruixen UI. Changes: the pill carries a live line and links to the
// round; the three overlapping showcase cards are replaced by one product window (children); the
// trusted-by logo strip is removed (we have none); our button looks; entrance via .front-rise.
import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils.ts";
import { buttonClass } from "../ui/button.ts";
import { HeroScene } from "./scene.tsx";

type Action = { href: string; label: string };

export interface HeroProps {
  pill: ReactNode;
  pillHref: string;
  title: ReactNode;
  description: string;
  primaryAction: Action;
  secondaryAction: Action;
  /** The product picture, rising below the text. */
  children: ReactNode;
  className?: string;
}

export function Hero({ pill, pillHref, title, description, primaryAction, secondaryAction, children, className }: HeroProps) {
  const copy = (
    <div className="pt-16 md:pt-24">
      <div className="front-rise relative mx-auto max-w-[1278px] px-6">
        <div className="flex justify-center">
          <Link href={pillHref} className="flex max-w-full items-center gap-2 rounded-full bg-card/80 px-3.5 py-1 text-sm text-foreground no-underline shadow-sm ring-1 ring-border backdrop-blur-sm transition-colors hover:bg-card">
            {pill}
          </Link>
        </div>
        <div className="mt-6 text-center *:mx-auto">
          <h1 id="hero-h" className="font-display mb-4 max-w-[976px] text-balance text-6xl leading-[1] text-foreground">
            {title}
          </h1>
          <div className="max-w-[672px]">
            <p className="mb-6 text-balance text-lg leading-7 text-muted-foreground">{description}</p>
            <div className="flex flex-wrap justify-center gap-3">
              <Link href={primaryAction.href} className={buttonClass("primary", "sm")}>
                {primaryAction.label}
              </Link>
              <Link href={secondaryAction.href} className={buttonClass("secondary", "sm")}>
                {secondaryAction.label}
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
  return (
    <HeroScene
      className={cn("w-full", className)}
      copy={copy}
      frame={<div className="front-rise relative mx-auto mt-14 max-w-[1208px] px-4 [animation-delay:180ms] sm:px-6 md:mt-24">{children}</div>}
    />
  );
}
