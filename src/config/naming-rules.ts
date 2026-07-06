// §6.1 Naming convention: type_subtype_region_description_year_quarter
// e.g. evt_ws_all_dam workshop boston_2026_q3
// Source: 2026_Revised Taxonomy - campaign.pdf

export const TAXONOMY = {
  "Demand Gen": {
    abbr: "dg",
    subtypes: {
      "Direct Mail":                   "dm",
      "Display Ad":                    "disp",
      "Search":                        "srch",
      "External List":                 "extl",
      "ABM Advertisement":             "abm",
      "Content Syndication":           "csyn",
      "Paid Search":                   "ps",
      "Gifting":                       "gift",
      "Agent (Conversational Email)":  "agent",
    },
  },
  "Email": {
    abbr: "em",
    subtypes: {
      "Newsletter":                    "nwsl",
      "Transactional":                 "ops",
      "Promotion":                     "promo",
      "Follow-Up":                     "fu",
      "Nurture":                       "nur",
      "Retargeting":                   "rtgt",
    },
  },
  "Event": {
    abbr: "evt",
    subtypes: {
      "Roundtable":                    "rt",
      "Workshop":                      "ws",
      "Tradeshow":                     "ts",
      "Acquia Engage":                 "engage",
      "User Group":                    "ug",
      "Corporate Event":               "corp",
      "Webinar":                       "wbr",
    },
  },
  "Operational": {
    abbr: "ops",
    subtypes: {
      "Operational":                   "ops",
    },
  },
  "Social": {
    abbr: "soc",
    subtypes: {
      "Organic Social":                "org",
      "Paid Social":                   "paid",
    },
  },
  "Web": {
    abbr: "web",
    subtypes: {
      "Organic":                       "org",
      "Contact Sales":                 "cs",
      "Demo":                          "demo",
      "Web Form":                      "form",
      "Resources":                     "res",
      "Clickable Demos":               "cdemo",
      "AI Agents":                     "ai",
      "Chatbot":                       "chat",
      "Corporate/Brand/Sponsorship":   "brand",
      "AcquiaTV":                      "tv",
    },
  },
} as const;

export type CampaignType = keyof typeof TAXONOMY;

export const VALID_REGIONS = ["AMER", "EMEA", "APJ", "LATAM", "ALL"] as const;
export type Region = (typeof VALID_REGIONS)[number];

export const VALID_QUARTERS = ["q1", "q2", "q3", "q4"] as const;
export type Quarter = (typeof VALID_QUARTERS)[number];

export interface ParsedName {
  type: CampaignType;
  typeAbbr: string;
  subtype: string;
  subtypeAbbr: string;
  region: Region;
  description: string;
  year: number;
  quarter: Quarter;
}

export function getTypeAbbr(type: CampaignType): string {
  return TAXONOMY[type].abbr;
}

export function getSubtypeAbbr(type: CampaignType, subtype: string): string | undefined {
  return (TAXONOMY[type].subtypes as Record<string, string>)[subtype];
}

export function buildCampaignName(
  type: CampaignType,
  subtype: string,
  region: Region,
  description: string,
  year: number,
  quarter: Quarter
): string {
  const typeAbbr = getTypeAbbr(type);
  const subtypeAbbr =
    getSubtypeAbbr(type, subtype) ??
    subtype.toLowerCase().replace(/\s+/g, "-");
  const cleanDesc = description.toLowerCase().trim();
  return `${typeAbbr}_${subtypeAbbr}_${region.toLowerCase()}_${cleanDesc}_${year}_${quarter}`;
}

export function quarterFromDate(date: Date): Quarter {
  const month = date.getMonth() + 1;
  if (month <= 3) return "q1";
  if (month <= 6) return "q2";
  if (month <= 9) return "q3";
  return "q4";
}
