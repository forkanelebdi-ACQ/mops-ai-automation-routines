// Shared Zod schemas — used by schemaTask payloads and for runtime validation of Claude output.

import { z } from "zod";
import { VALID_REGIONS, VALID_TYPES, VALID_QUARTERS } from "../config/naming-rules.js";

// ---- primitive enums ----

export const RegionSchema = z.enum(VALID_REGIONS);
export const CampaignTypeSchema = z.enum(VALID_TYPES);
export const QuarterSchema = z.enum(VALID_QUARTERS);

// ---- classification (shared core across a1 → a5 → a2) ----

export const ClassificationSchema = z.object({
  type: CampaignTypeSchema,
  region: RegionSchema,
  goLiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD"),
  quarter: QuarterSchema,
  campaignName: z.string().min(1),
  budget: z.string().optional(),
  goal: z.string().optional(),
  audience: z.string().optional(),
  keyMessage: z.string().optional(),
  parentProgramId: z.string().optional(),
});

export type Classification = z.infer<typeof ClassificationSchema>;

// ---- a1: intake triage ----

export const TriagePayloadSchema = z.object({
  asanaTaskId: z.string().min(1),
});

export const TriageOutputSchema = z.object({
  asanaTaskId: z.string(),
  classification: ClassificationSchema,
  owner: z.string(),
  priority: z.enum(["standard", "urgent", "needs-info"]),
  confidence: z.number().min(0).max(1),
  needsHuman: z.boolean(),
  reason: z.string().optional(),
});

export type TriagePayload = z.infer<typeof TriagePayloadSchema>;
export type TriageOutput = z.infer<typeof TriageOutputSchema>;

// Raw shape Claude returns for triage; includes fields we validate before trusting
export const RawTriageResponseSchema = z.object({
  type: z.string(),
  region: z.string(),
  goLiveDate: z.string(),
  quarter: z.string(),
  campaignName: z.string(),
  budget: z.string().nullable().optional(),
  goal: z.string().nullable().optional(),
  audience: z.string().nullable().optional(),
  keyMessage: z.string().nullable().optional(),
  parentProgramId: z.string().nullable().optional(),
  confidence: z.number(),
  priority: z.string(),
  issues: z.array(z.string()),
});

// ---- a5: naming enforcer ----

export const NamingPayloadSchema = z.object({
  asanaTaskId: z.string().min(1),
  classification: ClassificationSchema,
});

export const NamingOutputSchema = z.object({
  approved: z.boolean(),
  approvedName: z.string().optional(),
  suggestedName: z.string().optional(),
  reason: z.string().optional(),
});

export type NamingPayload = z.infer<typeof NamingPayloadSchema>;
export type NamingOutput = z.infer<typeof NamingOutputSchema>;

// ---- a2: Salesforce campaign build ----

export const SfCampaignPayloadSchema = z.object({
  asanaTaskId: z.string().min(1),
  approvedName: z.string().min(1),
  classification: ClassificationSchema,
  owner: z.string(),
});

export const SfCampaignOutputSchema = z.object({
  sfCampaignId: z.string(),
  pardotCampaignId: z.string().optional(),
});

export type SfCampaignPayload = z.infer<typeof SfCampaignPayloadSchema>;
export type SfCampaignOutput = z.infer<typeof SfCampaignOutputSchema>;

// ---- a3: asset checklist (stub) ----

export const AssetChecklistPayloadSchema = z.object({
  asanaTaskId: z.string().min(1),
  classification: ClassificationSchema,
  sfCampaignId: z.string().optional(),
});

export type AssetChecklistPayload = z.infer<typeof AssetChecklistPayloadSchema>;

// ---- a4: brief drafting (stub) ----

export const BriefDraftingPayloadSchema = z.object({
  asanaTaskId: z.string().min(1),
  classification: ClassificationSchema,
  sfCampaignId: z.string().optional(),
});

export type BriefDraftingPayload = z.infer<typeof BriefDraftingPayloadSchema>;

// ---- audit log entry (written to Airtable by every task) ----

export const AuditEntrySchema = z.object({
  taskId: z.string(),
  automation: z.string(),
  decision: z.string(),
  confidence: z.number().optional(),
  model: z.string().optional(),
  timestamp: z.string(),
  data: z.record(z.unknown()).optional(),
});

export type AuditEntry = z.infer<typeof AuditEntrySchema>;
