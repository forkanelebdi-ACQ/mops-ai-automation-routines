// §6.4 Asset checklists by campaign type/subtype
// Turned into Asana subtasks by a3.
// Source: 2026_Revised Taxonomy - campaign.pdf (aligned with naming-rules.ts TAXONOMY).

import type { CampaignType } from "./naming-rules.js";

/** Default checklist per top-level type. Used when no subtype override applies. */
export const ASSET_CHECKLISTS: Record<CampaignType, string[]> = {
  "Demand Gen": [
    "Ad copy variants (headline / body / CTA)",
    "Landing page + form aligned",
    "UTMs + tracking pixels",
    "Content asset to DAM + linked",
    "Brief shared with demand-gen lead",
  ],
  "Email": [
    "HTML email build",
    "Plain text version",
    "List-pull segmentation brief",
    "Pardot email record + send config",
    "UTM params",
    "A/B subject line variants",
  ],
  "Event": [
    "Landing page + form",
    "Email invite #1",
    "Email invite #2",
    "Email invite #3",
    "Reminder email #1",
    "Reminder email #2",
    "Follow-up email — Attended",
    "Follow-up email — No Show",
    "SF campaign + child campaigns",
    "Speaker brief",
    "Run-of-show",
    "Post-event attended vs no-show cadence",
  ],
  // TODO(ground-truth): Operational sends are typically transactional/system emails — confirm
  // this lightweight checklist matches what the org actually requires before relying on it.
  "Operational": [
    "Send config + trigger logic documented",
    "QA pass on trigger conditions",
    "Suppression / exclusion list confirmed",
  ],
  // TODO(ground-truth): confirm with social team.
  "Social": [
    "Post copy variants (2-3)",
    "Creative asset (image/video) sized per platform",
    "UTM params",
    "Posting schedule confirmed",
    "Brief shared with social lead",
  ],
  // TODO(ground-truth): confirm with web team.
  "Web": [
    "Page copy / content brief",
    "Creative asset to DAM + linked",
    "UTMs + tracking pixels",
    "Page live + QA'd",
    "Brief shared with web lead",
  ],
};

/**
 * Subtype-specific overrides for types whose asset needs vary meaningfully by subtype.
 * Checked before falling back to the type-level default in ASSET_CHECKLISTS.
 */
export const ASSET_CHECKLIST_SUBTYPE_OVERRIDES: Partial<Record<string, string[]>> = {
  Webinar: [
    "Landing page + form",
    "Email invite #1",
    "Email invite #2",
    "Email invite #3",
    "Reminder email #1",
    "Reminder email #2",
    "Follow-up email — Attended",
    "Follow-up email — No Show",
    "On-demand recording asset",
    "SF campaign",
  ],
};

/** Returns the asset checklist for a campaign, preferring a subtype override over the type default. */
export function getAssetChecklist(type: CampaignType, subtype?: string): string[] {
  if (subtype && ASSET_CHECKLIST_SUBTYPE_OVERRIDES[subtype]) {
    return ASSET_CHECKLIST_SUBTYPE_OVERRIDES[subtype]!;
  }
  return ASSET_CHECKLISTS[type];
}
