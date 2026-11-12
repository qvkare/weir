import { HomePage } from "@/components/pages/home-page.tsx";
import { DEFAULT_MARKET } from "@/lib/config.ts";

// Static at build time: the default market's figures as the build read them. The other markets are
// /m/<market>/ (the site's Worker serves them for ?m=<market>), and the browser reads live figures.
export default function Page() {
  return <HomePage market={DEFAULT_MARKET} />;
}
