// §6.4 Asset checklists by campaign type
// Turned into Asana subtasks by a3.

import type { CampaignType } from "./naming-rules.js";

export const ASSET_CHECKLISTS: Record<CampaignType, string[]> = {
  Event: [
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
  Email: [
    "HTML email build",
    "Plain text version",
    "List-pull segmentation brief",
    "Pardot email record + send config",
    "UTM params",
    "A/B subject line variants",
  ],
  Paid: [
    "Ad copy variants (headline / body / CTA)",
    "Landing page + form aligned",
    "UTMs + tracking pixels",
    "Content asset to DAM + linked",
    "Brief shared with demand-gen lead",
  ],
  Content: [
    "Ad copy variants (headline / body / CTA)",
    "Landing page + form aligned",
    "UTMs + tracking pixels",
    "Content asset to DAM + linked",
    "Brief shared with demand-gen lead",
  ],
};
