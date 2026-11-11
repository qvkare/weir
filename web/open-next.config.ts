import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Every data page is rendered per request (the chain moves every few seconds), so no
// incremental cache binding is needed. Static assets are served by the Workers asset binding.
export default defineCloudflareConfig({});
