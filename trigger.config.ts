import { defineConfig } from "@trigger.dev/sdk/v3";

export default defineConfig({
  project: "mops-ai-automation",
  runtime: "node",
  logLevel: "log",
  dirs: ["src/trigger"],
});
