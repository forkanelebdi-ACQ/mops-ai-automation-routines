// §6.1 Naming convention: Region_Channel_Product_Description_YYYY-Qn
// e.g. EMEA_Webinar_AcquiaCMS_DrupalSecurityForEnterprises_2026-Q3

export const VALID_REGIONS = ["AMER", "EMEA", "APJ", "LATAM"] as const;
export type Region = (typeof VALID_REGIONS)[number];

export const VALID_CHANNELS = ["Event", "Webinar", "Email", "Paid", "Content"] as const;
export type Channel = (typeof VALID_CHANNELS)[number];

export const VALID_QUARTERS = ["Q1", "Q2", "Q3", "Q4"] as const;
export type Quarter = (typeof VALID_QUARTERS)[number];

// 5 segments separated by "_"; Product and Description are PascalCase
export const NAMING_PATTERN =
  /^(AMER|EMEA|APJ|LATAM)_(Event|Webinar|Email|Paid|Content)_([A-Z][A-Za-z0-9]+)_([A-Z][A-Za-z0-9]+)_(\d{4}-Q[1-4])$/;

export interface ParsedName {
  region: Region;
  channel: Channel;
  product: string;
  description: string;
  year: number;
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
    const [, region, channel, product, description, date] = match;
    const [yearStr, quarter] = date.split("-");
    return {
      valid: true,
      issues: [],
      parsed: {
        region: region as Region,
        channel: channel as Channel,
        product,
        description,
        year: parseInt(yearStr, 10),
        quarter: quarter as Quarter,
      },
    };
  }

  const issues: string[] = [];
  const parts = name.split("_");

  if (parts.length !== 5) {
    issues.push(
      `Expected 5 underscore-separated segments [Region_Channel_Product_Description_YYYY-Qn]; got ${parts.length}`
    );
    return { valid: false, issues };
  }

  const [region, channel, product, description, date] = parts;

  if (!VALID_REGIONS.includes(region as Region)) {
    issues.push(`Region "${region}" must be one of ${VALID_REGIONS.join(", ")}`);
  }
  if (!VALID_CHANNELS.includes(channel as Channel)) {
    issues.push(`Channel "${channel}" must be one of ${VALID_CHANNELS.join(", ")}`);
  }
  if (!/^[A-Z][A-Za-z0-9]+$/.test(product)) {
    issues.push(`Product "${product}" must be PascalCase (e.g. AcquiaCMS, CloudPlatform)`);
  }
  if (!/^[A-Z][A-Za-z0-9]+$/.test(description)) {
    issues.push(`Description "${description}" must be PascalCase (e.g. DrupalSecurityForEnterprises)`);
  }
  if (!/^\d{4}-Q[1-4]$/.test(date)) {
    issues.push(`Date "${date}" must be in YYYY-Qn format (e.g. 2026-Q3)`);
  }

  return { valid: false, issues };
}

export function buildCampaignName(
  region: Region,
  channel: Channel,
  product: string,
  description: string,
  year: number,
  quarter: Quarter
): string {
  const sanitize = (s: string) =>
    s.split(/[\s\-_]+/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join("");
  return `${region}_${channel}_${sanitize(product)}_${sanitize(description)}_${year}-${quarter}`;
}

export function quarterFromDate(date: Date): Quarter {
  const month = date.getMonth() + 1;
  if (month <= 3) return "Q1";
  if (month <= 6) return "Q2";
  if (month <= 9) return "Q3";
  return "Q4";
}
