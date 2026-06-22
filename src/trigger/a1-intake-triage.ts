// a1: Intake Triage
// Reads the Asana intake form task, classifies campaign type/region, sets priority,
// determines the regional owner, and flags low-confidence submissions for human review.

import { schemaTask } from "@trigger.dev/sdk";
import { TriagePayloadSchema, RawTriageResponseSchema, ClassificationSchema } from "../ai/schemas.js";
import type { TriageOutput } from "../ai/schemas.js";
import { classify, escalate, MODELS } from "../ai/claude.js";
import { buildTriagePrompt } from "../ai/prompts.js";
import { fetchTask } from "../lib/asana.js";
import { logDecision } from "../lib/airtable.js";
import { getOwner, CONFIDENCE_FLOOR } from "../config/routing.js";

export const a1IntakeTriage = schemaTask({
  id: "a1-intake-triage",
  schema: TriagePayloadSchema,
  retry: {
    maxAttempts: 3,
    factor: 2,
    minTimeoutInMs: 2000,
    maxTimeoutInMs: 30_000,
  },

  run: async (payload): Promise<TriageOutput> => {
    const { asanaTaskId } = payload;

    // 1. Fetch the intake form task from Asana
    const submission = await fetchTask(asanaTaskId);

    // 2. Build the triage prompt and classify (haiku — fast and cheap)
    const prompt = buildTriagePrompt(submission.fields);
    let rawText: string;
    try {
      rawText = await classify(prompt);
    } catch (err) {
      // Retry the prompt with a more capable model on failure
      rawText = await escalate(prompt);
    }

    // 3. Parse and validate Claude's JSON response
    let rawParsed: unknown;
    try {
      rawParsed = JSON.parse(rawText);
    } catch {
      return {
        asanaTaskId,
        classification: {
          type: "Event",         // placeholder
          region: "AMER",       // placeholder
          goLiveDate: new Date().toISOString().slice(0, 10),
          quarter: "Q1",
          campaignName: submission.name,
        },
        owner: "Unknown",
        priority: "needs-info",
        confidence: 0,
        needsHuman: true,
        reason: "Claude returned non-JSON; routing to human review",
      };
    }

    const rawResult = RawTriageResponseSchema.safeParse(rawParsed);
    if (!rawResult.success) {
      return {
        asanaTaskId,
        classification: {
          type: "Event",
          region: "AMER",
          goLiveDate: new Date().toISOString().slice(0, 10),
          quarter: "Q1",
          campaignName: submission.name,
        },
        owner: "Unknown",
        priority: "needs-info",
        confidence: 0,
        needsHuman: true,
        reason: `Schema mismatch in Claude response: ${rawResult.error.message}`,
      };
    }

    const raw = rawResult.data;

    // 4. Promote to strict classification schema (handles null → undefined for optional fields)
    const classificationResult = ClassificationSchema.safeParse({
      type:             raw.type,
      region:           raw.region,
      goLiveDate:       raw.goLiveDate,
      quarter:          raw.quarter,
      campaignName:     raw.campaignName,
      budget:           raw.budget ?? undefined,
      goal:             raw.goal ?? undefined,
      audience:         raw.audience ?? undefined,
      keyMessage:       raw.keyMessage ?? undefined,
      parentProgramId:  raw.parentProgramId ?? undefined,
    });

    const confidenceTooLow = raw.confidence < CONFIDENCE_FLOOR;
    const hasIssues = raw.issues.length > 0;
    const classificationFailed = !classificationResult.success;
    const needsHuman = confidenceTooLow || hasIssues || classificationFailed;

    // Use a safe fallback classification for the return even if parsing failed
    const classification = classificationResult.success
      ? classificationResult.data
      : {
          type: "Event" as const,
          region: "AMER" as const,
          goLiveDate: new Date().toISOString().slice(0, 10),
          quarter: "Q1" as const,
          campaignName: raw.campaignName || submission.name,
        };

    const owner = classificationResult.success ? getOwner(classification.region) : "Unknown";

    const priority = (["standard", "urgent", "needs-info"].includes(raw.priority)
      ? raw.priority
      : "needs-info") as "standard" | "urgent" | "needs-info";

    // 5. Audit log
    await logDecision(asanaTaskId, {
      taskId:     asanaTaskId,
      automation: "a1-intake-triage",
      decision:   needsHuman ? "routed-to-human" : "classified",
      confidence: raw.confidence,
      model:      MODELS.classify,
      timestamp:  new Date().toISOString(),
      data: {
        type:       raw.type,
        region:     raw.region,
        priority:   raw.priority,
        issues:     raw.issues,
        needsHuman,
      },
    });

    const reason = needsHuman
      ? [
          classificationFailed ? `Classification parse error: ${classificationResult.success ? "" : classificationResult.error.message}` : "",
          confidenceTooLow ? `Confidence ${raw.confidence} below floor ${CONFIDENCE_FLOOR}` : "",
          hasIssues ? `Issues: ${raw.issues.join("; ")}` : "",
        ]
          .filter(Boolean)
          .join(". ")
      : undefined;

    return { asanaTaskId, classification, owner, priority, confidence: raw.confidence, needsHuman, reason };
  },
});
