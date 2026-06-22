// §6.1 Naming convention: [Year]_[Region]_[Type]_[CampaignName]_[Quarter]
// e.g. 2026_EMEA_Webinar_DrupalSecurity_Q3

export const VALID_REGIONS = ["AMER", "EMEA", "APJ", "LATAM"] as const;
export type Region = (typeof VALID_REGIONS)[number];

export const VALID_TYPES = ["Event", "Webinar", "Email", "Paid", "Content"] as const;
export type CampaignType = (typeof VALID_TYPES)[number];

export const VALID_QUARTERS = ["Q1", "Q2", "Q3", "Q4"] as const;
export type Quarter = (typeof VALID_QUARTERS)[number];

// Full pattern — each segment separated by a single underscore
export const NAMING_PATTERN =
  /^(\d{4})_(AMER|EMEA|APJ|LATAM)_(Event|Webinar|Email|Paid|Content)_([A-Z][A-Za-z0-9]+)_(Q[1-4])$/;

export interface ParsedName {
  year: number;
  region: Region;
  type: CampaignType;
  campaignName: string;
  quarter: Quarter;
}

export interface ValidationResult {
  valid: boolean;
  issues: string[];
  parsed?: ParsedName;
}

export function validateCampaignName(name: string): ValidationResult {
  const match = NAMING_PATTERN.exec(name);
  if (match) {
    const [, yearStr, region, type, campaignName, quarter] = match;
    return {
      valid: true,
      issues: [],
      parsed: {
        year: parseInt(yearStr, 10),
        region: region as Region,
        type: type as CampaignType,
        campaignName,
        quarter: quarter as Quarter,
      },
    };
  }

  // Identify specific violations for the correction prompt
  const issues: string[] = [];
  const parts = name.split("_");

  if (parts.length < 5) {
    issues.push(
      `Expected 5 underscore-separated segments [Year_Region_Type_CampaignName_Quarter]; got ${parts.length}`
    );
    return { valid: false, issues };
  }

  const [year, region, type, campaignName, quarter, ...extra] = parts;
  if (extra.length > 0) {
    issues.push(`Too many segments (${parts.length}); CampaignName may not contain underscores`);
  }
  if (!/^\d{4}$/.test(year)) {
    issues.push(`Year "${year}" must be exactly 4 digits`);
  }
  if (!VALID_REGIONS.includes(region as Region)) {
    issues.push(`Region "${region}" must be one of ${VALID_REGIONS.join(", ")}`);
  }
  if (!VALID_TYPES.includes(type as CampaignType)) {
    issues.push(`Type "${type}" must be one of ${VALID_TYPES.join(", ")}`);
  }
  if (!/^[A-Z][A-Za-z0-9]+$/.test(campaignName)) {
    issues.push(
      `CampaignName "${campaignName}" must be PascalCase (start with uppercase, alphanumeric only, no spaces or separators)`
    );
  }
  if (!/^Q[1-4]$/.test(quarter)) {
    issues.push(`Quarter "${quarter}" must be Q1, Q2, Q3, or Q4`);
  }

  return { valid: false, issues };
}

/**
 * Assembles a compliant name from its parts.
 * Sanitizes the campaignName segment to PascalCase automatically.
 */
export function buildCampaignName(
  year: number,
  region: Region,
  type: CampaignType,
  rawCampaignName: string,
  quarter: Quarter
): string {
  const sanitized = rawCampaignName
    .split(/[\s_\-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join("");
  return `${year}_${region}_${type}_${sanitized}_${quarter}`;
}

/** Derives the quarter string from a Date. */
export function quarterFromDate(date: Date): Quarter {
  const month = date.getMonth() + 1;
  if (month <= 3) return "Q1";
  if (month <= 6) return "Q2";
  if (month <= 9) return "Q3";
  return "Q4";
}
