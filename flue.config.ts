import { defineConfig } from "@flue/runtime/config";

export default defineConfig({
  target: "cloudflare",
  // Keep platform traces enabled without capturing prompts, tool payloads, or
  // traffic-derived report content in Flue's agent-level spans.
  tracing: false,
});
