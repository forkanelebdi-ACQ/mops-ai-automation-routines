// §6.3 Salesforce Campaign Member Statuses by campaign type/subtype
// Applied by a2 after campaign creation.
// TODO(ground-truth): Verify these match the live org's CampaignMemberStatus picklist values exactly.
// Source: 2026_Revised Taxonomy - campaign.pdf (aligned with naming-rules.ts TAXONOMY).

import type { CampaignType } from "./naming-rules.js";

/** Default statuses per top-level type. Used when no subtype override applies. */
export const MEMBER_STATUSES: Record<CampaignType, string[]> = {
  "Demand Gen": ["Impression", "Clicked", "Form Fill", "Converted"],
  "Email": ["Sent", "Opened", "Clicked", "Bounced", "Unsubscribed"],
  "Event": ["Registered", "Attended", "No Show", "Walk-in", "Booth Visit"],
  "Operational": ["Sent", "Delivered", "Failed"],
  "Social": ["Impression", "Clicked", "Engaged", "Converted"],
  "Web": ["Viewed", "Downloaded", "Engaged", "Converted"],
};

/** Statuses that count as "responded" for HasResponded on the SF CampaignMemberStatus object. */
export const RESPONDED_STATUSES: Record<CampaignType, string[]> = {
  "Demand Gen": ["Form Fill", "Converted"],
  "Email": ["Clicked"],
  "Event": ["Attended", "Walk-in", "Booth Visit"],
  "Operational": ["Delivered"],
  "Social": ["Clicked", "Engaged", "Converted"],
  "Web": ["Downloaded", "Engaged", "Converted"],
};

/**
 * Subtype-specific overrides for types whose member-status needs vary meaningfully by subtype.
 * Checked before falling back to the type-level default above.
 */
export const MEMBER_STATUS_SUBTYPE_OVERRIDES: Partial<Record<string, string[]>> = {
  Webinar: ["Registered", "Attended", "No Show", "On-Demand View"],
};

export const RESPONDED_STATUS_SUBTYPE_OVERRIDES: Partial<Record<string, string[]>> = {
  Webinar: ["Attended", "On-Demand View"],
};

export function getMemberStatuses(type: CampaignType, subtype?: string): string[] {
  if (subtype && MEMBER_STATUS_SUBTYPE_OVERRIDES[subtype]) {
    return MEMBER_STATUS_SUBTYPE_OVERRIDES[subtype]!;
  }
  return MEMBER_STATUSES[type];
}

export function getRespondedStatuses(type: CampaignType, subtype?: string): string[] {
  if (subtype && RESPONDED_STATUS_SUBTYPE_OVERRIDES[subtype]) {
    return RESPONDED_STATUS_SUBTYPE_OVERRIDES[subtype]!;
  }
  return RESPONDED_STATUSES[type];
}
