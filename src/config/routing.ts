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
 * Used as the region-level default by getAmTerritoriesForCampaign.
 */
export const REGION_AM_TERRITORIES: Record<Region, string[]> = {
  AMER: ["AM NA Key", "AM NA Regional", "AM NA CAM", "AM NA GLAM", "AM NA PubSec", "AM NA/EMEA Monsido", "AM Worldwide"],
  EMEA: ["AM EMEA Base", "AM EMEA GLAM", "AM NA/EMEA Monsido", "AM Worldwide"],
  APJ: ["AM APJ", "AM APJ Monsido", "AM Worldwide"],
  LATAM: ["AM NA Regional", "AM Worldwide"],
};

/**
 * Segment-specific territory groups used to narrow AM notifications.
 * Source: Acquia RevOps SFDC Accounts Structure — Tiers and Segments.
 * getAmTerritoriesForCampaign intersects this with the region list; falls back to
 * region default when the intersection is empty or segment is "All Segments".
 */
export const SEGMENT_AM_TERRITORY_GROUPS: Partial<Record<BusinessSegment, string[]>> = {
  Enterprise:     ["AM NA Key", "AM EMEA GLAM", "AM APJ", "AM Worldwide"],
  "Mid-Market":   ["AM NA Regional", "AM EMEA Base", "AM APJ Monsido", "AM Worldwide"],
  Growth:         ["AM NA CAM", "AM NA Regional", "AM Worldwide"],
  "Public Sector":["AM NA PubSec", "AM Worldwide"],
};

/**
 * Business segment thresholds aligned with Acquia's SFDC Business Segment field logic.
 * Enterprise: > $1B annual revenue
 * Mid-Market: $250M–$1B
 * Growth: < $250M
 * Public Sector: Government - Federal / Government - State/Local industries ONLY
 */
export const BUSINESS_SEGMENTS = ["Enterprise", "Mid-Market", "Growth", "Public Sector", "All Segments"] as const;
export type BusinessSegment = (typeof BUSINESS_SEGMENTS)[number];

/**
 * Account types a campaign can target, matching the SF Account Type field.
 * Source: Acquia RevOps SFDC Accounts Structure — Types of Accounts.
 */
export const ACCOUNT_TYPE_TARGETS = ["Prospect", "Customer", "Partner", "Former Customer", "All"] as const;
export type AccountTypeTarget = (typeof ACCOUNT_TYPE_TARGETS)[number];

/**
 * Global owner for campaign segmentation and audience targeting.
 * Receives a targeting brief DM on every new campaign spec posted to SF.
 */
export const SEGMENTATION_OWNER = "Felipe";

/** Confidence floor — below this threshold the triage is routed to human review. */
export const CONFIDENCE_FLOOR = 0.7;

/**
 * SLA escalation thresholds in business days, by campaign type.
 * Source: MOps Requests_SLA_Timeline_Requirements_2025.pdf.
 * If business days until go-live <= threshold and the task is still blocked,
 * escalate immediately regardless of how long it has been pending.
 * Webinar keeps the Event-level threshold via its subtype override; the other new types
 * (Operational, Social) are carried over from their closest retired equivalent pending
 * ground-truth confirmation from the SLA doc.
 * TODO(ground-truth): confirm Operational/Social thresholds against the live SLA doc.
 */
export const SLA_ESCALATION_DAYS: Record<string, number> = {
  Event:        7,
  Email:        5,
  "Demand Gen": 5,
  Web:          4,
  Social:       4,
  Operational:  3,
};

export function getOwner(region: Region): string {
  return REGION_OWNERS[region];
}

/** Region-only territory list (legacy helper). Prefer getAmTerritoriesForCampaign. */
export function getAmTerritories(region: Region): string[] {
  return REGION_AM_TERRITORIES[region];
}

/**
 * Returns the AM territory list for a campaign, narrowed by segment (and optionally
 * industry) before falling back to the region default.
 *
 * Resolution order:
 * 1. If segment is "All Segments" → return region default.
 * 2. Intersect SEGMENT_AM_TERRITORY_GROUPS[segment] with REGION_AM_TERRITORIES[region].
 * 3. If intersection is non-empty → return intersection.
 * 4. Otherwise → return region default.
 *
 * The optional `industry` parameter further narrows to PubSec territory when
 * industry is "Government - Federal" or "Government - State/Local".
 */
export function getAmTerritoriesForCampaign(
  region: Region,
  segment: BusinessSegment,
  industry?: string
): string[] {
  const regionList = REGION_AM_TERRITORIES[region];

  const isPubSecIndustry =
    industry === "Government - Federal" || industry === "Government - State/Local";

  if (isPubSecIndustry) {
    const pubSecGroup = SEGMENT_AM_TERRITORY_GROUPS["Public Sector"] ?? [];
    const intersection = pubSecGroup.filter((t) => regionList.includes(t));
    return intersection.length > 0 ? intersection : regionList;
  }

  if (segment === "All Segments") return regionList;

  const segmentGroup = SEGMENT_AM_TERRITORY_GROUPS[segment] ?? [];
  if (segmentGroup.length === 0) return regionList;

  const intersection = segmentGroup.filter((t) => regionList.includes(t));
  return intersection.length > 0 ? intersection : regionList;
}
