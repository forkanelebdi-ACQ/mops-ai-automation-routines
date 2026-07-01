// §6.2 Region → owner routing
// These owners receive triage notifications and naming-correction approval requests.

import type { Region } from "./naming-rules.js";

export const REGION_OWNERS: Record<Region, string> = {
  AMER: "Harish",
  EMEA: "Aayushi",
  APJ: "Aayushi",
  LATAM: "Felipe",
};

/**
 * AM territories that a campaign in each region may touch.
 * Source: Acquia RevOps SFDC Accounts Structure — AM Territories table.
 * Used by a2 to list the relevant account teams in the SF campaign spec.
 */
export const REGION_AM_TERRITORIES: Record<Region, string[]> = {
  AMER: ["AM NA Key", "AM NA Regional", "AM NA CAM", "AM NA GLAM", "AM NA PubSec", "AM NA/EMEA Monsido", "AM Worldwide"],
  EMEA: ["AM EMEA Base", "AM EMEA GLAM", "AM NA/EMEA Monsido", "AM Worldwide"],
  APJ: ["AM APJ", "AM APJ Monsido", "AM Worldwide"],
  LATAM: ["AM NA Regional", "AM Worldwide"],
};

/**
 * Business segment thresholds aligned with Acquia's SFDC Business Segment field logic.
 * Enterprise: > $1B annual revenue
 * Mid-Market: $250M–$1B
 * Growth: < $250M
 * Public Sector: Government - Federal / Government - State / Local industries
 */
export const BUSINESS_SEGMENTS = ["Enterprise", "Mid-Market", "Growth", "Public Sector", "All Segments"] as const;
export type BusinessSegment = (typeof BUSINESS_SEGMENTS)[number];

/**
 * Account types a campaign can target, matching the SF Account Type field.
 * Source: Acquia RevOps SFDC Accounts Structure — Types of Accounts.
 */
export const ACCOUNT_TYPE_TARGETS = ["Prospect", "Customer", "Partner", "All"] as const;
export type AccountTypeTarget = (typeof ACCOUNT_TYPE_TARGETS)[number];

/**
 * Global owner for campaign segmentation and audience targeting.
 * Receives a targeting brief DM on every new campaign spec posted to SF.
 */
export const SEGMENTATION_OWNER = "Felipe";

/** Hours before a no-response is escalated to the next tier. */
export const ESCALATION_HOURS = 24;

/** Confidence floor — below this threshold the triage is routed to human review. */
export const CONFIDENCE_FLOOR = 0.7;

export function getOwner(region: Region): string {
  return REGION_OWNERS[region];
}

export function getAmTerritories(region: Region): string[] {
  return REGION_AM_TERRITORIES[region];
}
