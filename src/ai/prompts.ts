// Prompt builders — all AI prompt construction lives here, never inline in tasks.

import type { Classification } from "./schemas.js";

/**
 * Builds the triage prompt for a1.
 * rawFields is a flat map of field name → value from the Asana intake form.
 */
export function buildTriagePrompt(rawFields: Record<string, string>): string {
  const fieldLines = Object.entries(rawFields)
    .map(([k, v]) => `${k}: ${v || "(empty)"}`)
    .join("\n");

  return `You are an expert marketing operations analyst. Analyze this Asana campaign intake form submission and extract structured data.

FORM SUBMISSION:
${fieldLines}

Return a JSON object with EXACTLY this structure. No markdown fences, no explanation — just the JSON:
{
  "type": "<one of: Event, Webinar, Email, Paid, Content>",
  "region": "<one of: AMER, EMEA, APJ, LATAM>",
  "goLiveDate": "<YYYY-MM-DD — derive from the go-live date field>",
  "quarter": "<Q1 | Q2 | Q3 | Q4 — must match the calendar quarter of goLiveDate>",
  "campaignName": "<the campaign name as submitted, or best extraction if absent>",
  "budget": "<budget range string or null>",
  "goal": "<one of: MQLs, pipeline, awareness, retention — or null>",
  "audience": "<target audience description or null>",
  "keyMessage": "<key message or null>",
  "parentProgramId": "<parent Asana task ID or null>",
  "confidence": <float 0.0–1.0 reflecting how complete and unambiguous the form is>,
  "priority": "<standard | urgent | needs-info>",
  "issues": ["<array of missing or contradictory fields — empty if none>"]
}`;
}

/**
 * Builds the naming-correction prompt for a5 when the submitted name is invalid.
 * issues is the list of specific violations from validateCampaignName().
 */
export function buildNamingCorrectionPrompt(
  submittedName: string,
  classification: Classification,
  issues: string[]
): string {
  const year = new Date(classification.goLiveDate).getFullYear();
  return `The proposed campaign name "${submittedName}" has naming convention violations:
${issues.map((i) => `  • ${i}`).join("\n")}

Required format: [Year]_[Region]_[Type]_[CampaignName]_[Quarter]
Example: 2026_EMEA_Webinar_DrupalSecurity_Q3

Campaign details:
  Year:    ${year}
  Region:  ${classification.region}
  Type:    ${classification.type}
  Quarter: ${classification.quarter}
  Raw name / description from form: "${classification.campaignName}"

Rules for the CampaignName segment:
  - PascalCase: each word starts with uppercase, rest lowercase
  - No spaces, underscores, hyphens, or special characters
  - Standard industry abbreviations are fine (AI, ABM, DG, B2B, etc.)

Return ONLY the corrected campaign name string. Nothing else.`;
}
