// a2: Salesforce Campaign Build
// ONLY reached after a5 has approved the campaign name (gate enforced in intake-pipeline).
// Creates the SF campaign with the correct type/dates/budget, applies the member-status set
// for the campaign type, and creates the Pardot connected campaign.

import { schemaTask } from "@trigger.dev/sdk";
import { SfCampaignPayloadSchema } from "../ai/schemas.js";
import type { SfCampaignOutput } from "../ai/schemas.js";
import { createCampaign, addMemberStatuses } from "../lib/salesforce.js";
import { createConnectedCampaign } from "../lib/pardot.js";
import { logDecision } from "../lib/airtable.js";
import { MEMBER_STATUSES, RESPONDED_STATUSES } from "../config/member-statuses.js";

export const a2SfCampaign = schemaTask({
  id: "a2-sf-campaign",
  schema: SfCampaignPayloadSchema,
  retry: {
    maxAttempts: 3,
    factor: 2,
    minTimeoutInMs: 5_000,
    maxTimeoutInMs: 60_000,
  },

  run: async (payload): Promise<SfCampaignOutput> => {
    const { asanaTaskId, approvedName, classification } = payload;

    const goLiveDate = classification.goLiveDate;
    const budget = classification.budget
      ? parseFloat(classification.budget.replace(/[^0-9.]/g, ""))
      : undefined;

    // 1. Create the Salesforce Campaign
    const sfCampaignId = await createCampaign({
      name:        approvedName,
      type:        classification.type,
      startDate:   goLiveDate,
      budget:      Number.isNaN(budget) ? undefined : budget,
      description: [
        `Region: ${classification.region}`,
        `Goal: ${classification.goal ?? "not specified"}`,
        `Audience: ${classification.audience ?? "not specified"}`,
        `Key message: ${classification.keyMessage ?? "not specified"}`,
        `Asana task: ${asanaTaskId}`,
      ].join("\n"),
    });

    // 2. Apply the member-status set for this campaign type (§6.3)
    const statuses  = MEMBER_STATUSES[classification.type];
    const responded = RESPONDED_STATUSES[classification.type];
    await addMemberStatuses(sfCampaignId, statuses, responded);

    // 3. Create the Pardot / Account Engagement connected campaign
    let pardotCampaignId: string | undefined;
    try {
      pardotCampaignId = await createConnectedCampaign(sfCampaignId, approvedName);
    } catch (err) {
      // Pardot failure should not roll back the SF campaign; log and continue
      console.error(`[a2] Pardot connected campaign creation failed (non-fatal):`, err);
      await logDecision(asanaTaskId, {
        taskId:     asanaTaskId,
        automation: "a2-sf-campaign",
        decision:   "pardot-failed",
        timestamp:  new Date().toISOString(),
        data: { sfCampaignId, error: String(err) },
      });
    }

    // 4. Audit log
    await logDecision(asanaTaskId, {
      taskId:     asanaTaskId,
      automation: "a2-sf-campaign",
      decision:   "campaign-created",
      timestamp:  new Date().toISOString(),
      data: {
        approvedName,
        sfCampaignId,
        pardotCampaignId,
        type:     classification.type,
        region:   classification.region,
        statuses,
      },
    });

    return { sfCampaignId, pardotCampaignId };
  },
});
