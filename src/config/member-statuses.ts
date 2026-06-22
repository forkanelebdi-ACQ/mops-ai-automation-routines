// §6.3 Salesforce Campaign Member Statuses by campaign type
// Applied by a2 after campaign creation.
// TODO(ground-truth): Verify these match the live org's CampaignMemberStatus picklist values exactly.

import type { CampaignType } from "./naming-rules.js";

export const MEMBER_STATUSES: Record<CampaignType, string[]> = {
  Event: ["Registered", "Attended", "No Show", "Walk-in", "Booth Visit"],
  Webinar: ["Registered", "Attended", "No Show", "On-Demand View"],
  Email: ["Sent", "Opened", "Clicked", "Bounced", "Unsubscribed"],
  Paid: ["Impression", "Clicked", "Form Fill", "Converted"],
  Content: ["Downloaded", "Viewed", "Engaged", "Converted"],
};

/** Statuses that count as "responded" for HasResponded on the SF CampaignMemberStatus object. */
export const RESPONDED_STATUSES: Record<CampaignType, string[]> = {
  Event: ["Attended", "Walk-in", "Booth Visit"],
  Webinar: ["Attended", "On-Demand View"],
  Email: ["Clicked"],
  Paid: ["Form Fill", "Converted"],
  Content: ["Downloaded", "Engaged", "Converted"],
};
