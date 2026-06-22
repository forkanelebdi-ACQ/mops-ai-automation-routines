// Intake Poller — runs every 5 minutes and fans out one pipeline run per new Asana task.
// Idempotency key `campaign-${id}` ensures the same task is never processed twice,
// even if it appears in two consecutive poll windows.

import { schedules } from "@trigger.dev/sdk";
import { intakePipeline } from "./intake-pipeline.js";
import { fetchNewSubmissions } from "../lib/asana.js";

export const intakePoller = schedules.task({
  id: "intake-poller",
  cron: "*/5 * * * *", // every 5 minutes

  run: async () => {
    const submissions = await fetchNewSubmissions();
    let dispatched = 0;

    for (const s of submissions) {
      // trigger (fire-and-forget from the poller's perspective) with idempotency key
      await intakePipeline.trigger(
        { asanaTaskId: s.id },
        { idempotencyKey: `campaign-${s.id}` }
      );
      dispatched++;
    }

    return { dispatched, total: submissions.length };
  },
});
