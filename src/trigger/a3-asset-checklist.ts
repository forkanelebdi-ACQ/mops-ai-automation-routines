// a3: Asset Checklist + Asana Subtasks
// Generates the per-type asset checklist (§6.4) and creates every item as an Asana subtask
// under the campaign's intake task. No AI needed — the checklist is fully defined in config.

import { schemaTask } from "@trigger.dev/sdk";
import { AssetChecklistPayloadSchema } from "../ai/schemas.js";
import type { AssetChecklistPayload } from "../ai/schemas.js";
import { ASSET_CHECKLISTS } from "../config/asset-checklists.js";
import { createSubtask, addTaskComment } from "../lib/asana.js";
import { logDecision } from "../lib/airtable.js";

export const a3AssetChecklist = schemaTask({
  id: "a3-asset-checklist",
  schema: AssetChecklistPayloadSchema,
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 2000, maxTimeoutInMs: 30_000 },

  run: async (payload: AssetChecklistPayload) => {
    const { asanaTaskId, classification } = payload;

    const assets = ASSET_CHECKLISTS[classification.type];

    // Create one Asana subtask per asset item, sequentially
    const createdGids: string[] = [];
    for (const assetName of assets) {
      const gid = await createSubtask(asanaTaskId, assetName);
      createdGids.push(gid);
    }

    // Post a summary comment so the regional owner sees what was generated
    const summary =
      `✅ Asset checklist created (${assets.length} items for ${classification.type}):\n` +
      assets.map((a) => `  • ${a}`).join("\n");
    await addTaskComment(asanaTaskId, summary);

    await logDecision(asanaTaskId, {
      taskId:     asanaTaskId,
      automation: "a3-asset-checklist",
      decision:   "subtasks-created",
      timestamp:  new Date().toISOString(),
      data: { type: classification.type, count: createdGids.length, assets },
    });

    return { ok: true, subtasksCreated: createdGids.length };
  },
});
