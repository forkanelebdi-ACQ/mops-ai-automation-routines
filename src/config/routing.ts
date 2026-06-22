// §6.2 Region → owner routing
// These owners receive triage notifications and naming-correction approval requests.

import type { Region } from "./naming-rules.js";

export const REGION_OWNERS: Record<Region, string> = {
  AMER: "Harish",
  EMEA: "Aayushi",
  APJ: "Aayushi",
  LATAM: "Felipe",
};

/** Hours before a no-response is escalated to the next tier. */
export const ESCALATION_HOURS = 24;

/** Confidence floor — below this threshold the triage is routed to human review. */
export const CONFIDENCE_FLOOR = 0.7;

export function getOwner(region: Region): string {
  return REGION_OWNERS[region];
}
