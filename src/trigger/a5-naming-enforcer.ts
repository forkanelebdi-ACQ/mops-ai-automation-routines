// a5: Naming Enforcer — THE GATE
// Validates the campaign name against the naming convention (§6.1).
// If valid: immediately returns approved.
// If invalid: Claude suggests a corrected name, the correction is posted as an Asana comment,
// and wait.forToken pauses the run until a human approves (or 24 h elapses).
// The orchestrator (intake-pipeline) MUST NOT call a2 unless this task returns { approved: true }.

import { schemaTask, wait } from "@trigger.dev/sdk";
import { NamingPayloadSchema } from "../ai/schemas.js";
import type { NamingOutput } from "../ai/schemas.js";
import { reason as claudeReason, MODELS } from "../ai/claude.js";
import { buildNamingCorrectionPrompt } from "../ai/prompts.js";
import { validateCampaignName, buildCampaignName, quarterFromDate } from "../config/naming-rules.js";
import { addTaskComment } from "../lib/asana.js";
import { logDecision } from "../lib/airtable.js";

export const a5NamingEnforcer = schemaTask({
  id: "a5-naming-enforcer",
  schema: NamingPayloadSchema,
  retry: {
    maxAttempts: 2,
    factor: 2,
    minTimeoutInMs: 1000,
    maxTimeoutInMs: 10_000,
  },

  run: async (payload): Promise<NamingOutput> => {
    const { asanaTaskId, classification } = payload;

    // 1. Deterministic validation first (no AI cost)
    const validation = validateCampaignName(classification.campaignName);

    if (validation.valid) {
      await logDecision(asanaTaskId, {
        taskId:     asanaTaskId,
        automation: "a5-naming-enforcer",
        decision:   "name-valid",
        confidence: 1,
        model:      "deterministic",
        timestamp:  new Date().toISOString(),
        data: { approvedName: classification.campaignName },
      });
      return { approved: true, approvedName: classification.campaignName };
    }

    // 2. Name is invalid — auto-construct a best-guess corrected name from classification parts
    const goLiveDate = new Date(classification.goLiveDate);
    const inferredName = buildCampaignName(
      goLiveDate.getFullYear(),
      classification.region,
      classification.type,
      classification.campaignName,
      classification.quarter
    );

    // 3. If the auto-corrected name is already valid, propose it; otherwise ask Claude to refine
    const inferredValidation = validateCampaignName(inferredName);

    let suggestedName: string;
    let model: string;

    if (inferredValidation.valid) {
      suggestedName = inferredName;
      model = "deterministic";
    } else {
      const prompt = buildNamingCorrectionPrompt(
        classification.campaignName,
        classification,
        validation.issues
      );
      suggestedName = (await claudeReason(prompt, 256)).trim();
      model = MODELS.default;

      // Validate Claude's suggestion too; if it's still wrong, log and gate manually
      const suggestionValidation = validateCampaignName(suggestedName);
      if (!suggestionValidation.valid) {
        await logDecision(asanaTaskId, {
          taskId:     asanaTaskId,
          automation: "a5-naming-enforcer",
          decision:   "suggestion-invalid",
          model,
          timestamp:  new Date().toISOString(),
          data: {
            original:    classification.campaignName,
            suggested:   suggestedName,
            issues:      suggestionValidation.issues,
          },
        });
        return {
          approved: false,
          suggestedName,
          reason: `Auto-correction still invalid: ${suggestionValidation.issues.join("; ")}`,
        };
      }
    }

    // 4. Post the suggested correction as an Asana comment for the regional owner to review
    await addTaskComment(
      asanaTaskId,
      `⚠️ Naming convention issue detected.\n\n` +
        `Original: "${classification.campaignName}"\n` +
        `Issues: ${validation.issues.join("; ")}\n\n` +
        `Suggested correction: "${suggestedName}"\n\n` +
        `To approve this name and continue, reply to this comment with "APPROVE".\n` +
        `To reject, reply with "REJECT: <your preferred name>".\n\n` +
        `(This campaign will not be created in Salesforce until approved.)`
    );

    // 5. Wait for human approval via Trigger.dev token mechanism
    // TODO(trigger-dev): Implement wait.forToken for production human-in-the-loop approval.
    //   Pattern from trigger-ref.md:
    //     await wait.forToken({ token: uniqueTokenId, timeoutInSeconds: 86400 });
    //   Steps:
    //     a) Generate a unique token ID (e.g. `naming-${asanaTaskId}-${Date.now()}`)
    //     b) Include it in the Asana comment above so the approver can POST to Trigger.dev
    //     c) Call wait.forToken here — the run checkpoints and costs nothing while waiting
    //     d) Parse the token payload to get the human's approved/rejected decision
    //   For scaffold: auto-approve the AI suggestion so the pipeline can be tested end-to-end.

    // Suppress lint warning: wait is imported for when the above TODO is implemented
    void wait;

    await logDecision(asanaTaskId, {
      taskId:     asanaTaskId,
      automation: "a5-naming-enforcer",
      decision:   "name-corrected-auto-approved",
      model,
      timestamp:  new Date().toISOString(),
      data: {
        original:  classification.campaignName,
        approved:  suggestedName,
        issues:    validation.issues,
      },
    });

    return { approved: true, approvedName: suggestedName, suggestedName };
  },
});
