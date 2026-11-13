"use client";
// The test bid view, loaded only where it is shown: the application's other views share one
// chunk (components/pages/app-page.tsx imports them all), and this keeps the test bid out of it.
// It is still rendered into the page's HTML at build.
import dynamic from "next/dynamic";

export const TryViewLazy = dynamic(() => import("./try-view.tsx").then((m) => m.TryView));
