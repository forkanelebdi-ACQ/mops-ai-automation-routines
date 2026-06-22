// Orchestrator: per-ticket pipeline
// Order is fixed and non-negotiable (§2):
//   a1 (triage) → a5 (naming GATE) → a2 (SF build) → a3 (assets) → a4 (brief)
//
// Rules:
//   - a5 MUST return { approved: true } before a2 is called
//   - All triggerAndWait calls use .unwrap() — they throw on task failure
//   - NEVER wrap triggerAndWait / batchTriggerAndWait / wait.* in Promise.all

import { task } from "@trigger.dev/sdk";
import { a1IntakeTriage } from "./a1-intake-triage.js";
import { a5NamingEnforcer } from "./a5-naming-enforcer.js";
import { a2SfCampaign } from "./a2-sf-campaign.js";
import { a3AssetChecklist } from "./a3-asset-checklist.js";
import { a4BriefDrafting } from "./a4-brief-drafting.js";

export const intakePipeline = task({
  id: "intake-pipeline",
  retry: {
    maxAttempts: 1, // orchestrators don't retry — individual tasks have their own retries
  },

  run: async (payload: { asanaTaskId: string }) => {
    const { asanaTaskId } = payload;

    // ── Step 1: Triage ──────────────────────────────────────────────────────
    const triage = await a1IntakeTriage
      .triggerAndWait({ asanaTaskId })
      .unwrap();

    if (triage.needsHuman) {
      return {
        stoppedAt: "a1",
        reason:    triage.reason ?? "Low confidence or missing/contradictory fields",
        asanaTaskId,
      };
    }

    // ── Step 5: Naming Gate — MUST pass before a2 ───────────────────────────
    const gate = await a5NamingEnforcer
      .triggerAndWait({ asanaTaskId, classification: triage.classification })
      .unwrap();

    if (!gate.approved) {
      return {
        stoppedAt:     "a5",
        reason:        gate.reason ?? "Campaign name not approved",
        suggestedName: gate.suggestedName,
        asanaTaskId,
      };
    }

    // Gate passed — approvedName is guaranteed to be set when approved === true
    const approvedName = gate.approvedName!;

    // ── Step 2: Build SF Campaign ────────────────────────────────────────────
    const build = await a2SfCampaign
      .triggerAndWait({
        asanaTaskId,
        approvedName,
        classification: triage.classification,
        owner:          triage.owner,
      })
      .unwrap();

    // ── Step 3: Asset Checklist ──────────────────────────────────────────────
    // Sequential await — NEVER Promise.all on triggerAndWait
    await a3AssetChecklist
      .triggerAndWait({
        asanaTaskId,
        classification: triage.classification,
        sfCampaignId:   build.sfCampaignId,
      })
      .unwrap();

    // ── Step 4: Campaign Brief ───────────────────────────────────────────────
    await a4BriefDrafting
      .triggerAndWait({
        asanaTaskId,
        classification: triage.classification,
        sfCampaignId:   build.sfCampaignId,
      })
      .unwrap();

    return {
      ok:           true,
      asanaTaskId,
      sfCampaignId: build.sfCampaignId,
      approvedName,
    };
  },
});
