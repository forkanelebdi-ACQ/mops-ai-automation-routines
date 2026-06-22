# MOps AI Automation — Technical Reference

> Complete technical breakdown of the system: architecture, data flow, task implementations,
> integration contracts, configuration rules, and deployment guide.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Architecture](#2-architecture)
3. [Pipeline: Data Flow End-to-End](#3-pipeline-data-flow-end-to-end)
4. [Task Reference](#4-task-reference)
   - [intake-poller](#41-intake-poller)
   - [intake-pipeline (orchestrator)](#42-intake-pipeline-orchestrator)
   - [a1 — Intake Triage](#43-a1--intake-triage)
   - [a5 — Naming Enforcer (Gate)](#44-a5--naming-enforcer-gate)
   - [a2 — Salesforce Campaign Build](#45-a2--salesforce-campaign-build)
   - [a3 — Asset Checklist](#46-a3--asset-checklist)
   - [a4 — Brief Drafting](#47-a4--brief-drafting)
   - [a6 — Sync Watchdog](#48-a6--sync-watchdog)
5. [Configuration Modules](#5-configuration-modules)
6. [AI Layer](#6-ai-layer)
7. [Integration Clients](#7-integration-clients)
8. [Schemas and Type System](#8-schemas-and-type-system)
9. [Trigger.dev Conventions](#9-triggerdev-conventions)
10. [Environment Variables](#10-environment-variables)
11. [Error Handling and Retries](#11-error-handling-and-retries)
12. [Security Model](#12-security-model)
13. [Deployment](#13-deployment)
14. [Ground-Truth TODO List](#14-ground-truth-todo-list)
15. [Repository Structure](#15-repository-structure)

---

## 1. System Overview

### Problem

The MOps team is the manual integration layer between four systems that do not talk to each other:

```
Asana intake form  →  (human reads + re-keys)  →  Asana task  →  Salesforce  →  Pardot
```

Every campaign request requires a person to:
1. Read the form submission
2. Validate the campaign name against a naming convention
3. Create the Salesforce campaign with the right type, dates, budget, and member statuses
4. Create subtasks in Asana for every required asset
5. Draft a campaign brief
6. Periodically check that Pardot and Salesforce member counts stay in sync

This is slow (days per campaign), error-prone (naming drift breaks SF reporting), and impossible to audit consistently.

### Solution

From a single Asana form submission, the system automatically:
- Parses and classifies the intake data using Claude
- Validates the campaign name against the naming convention (and corrects it if needed)
- Creates the Salesforce campaign with the correct member-status scaffolding
- Creates all required Asana subtasks from the per-type asset checklist
- Drafts a one-page campaign brief and attaches it to the Asana task
- Monitors daily that Pardot and Salesforce member counts remain in sync

Human involvement is limited to approving name corrections and reviewing AI-drafted briefs.

---

## 2. Architecture

### Component Map

```
┌─────────────────────────────────────────────────────────────────┐
│                         Trigger.dev Cloud                       │
│                                                                 │
│  ┌──────────────────┐      ┌───────────────────────────────┐   │
│  │  intake-poller   │      │      intake-pipeline           │   │
│  │  (cron */5 min)  │─────▶│  orchestrator (per ticket)    │   │
│  └──────────────────┘      │                               │   │
│                             │  a1 → a5 (gate) → a2 → a3 → a4 │ │
│                             └───────────────────────────────┘   │
│                                                                 │
│  ┌──────────────────┐                                           │
│  │  a6-sync-watchdog│  (cron daily 09:00 UTC — independent)    │
│  └──────────────────┘                                           │
└─────────────────────────────────────────────────────────────────┘
          │                            │
          ▼                            ▼
   ┌─────────────┐            ┌──────────────────────┐
   │    Asana    │            │  Claude (Anthropic)  │
   │  (tasks,   │            │  haiku / sonnet / opus│
   │  subtasks, │            └──────────────────────┘
   │  comments) │
   └─────────────┘
          │
          ├──────────────────▶  Salesforce (campaigns, member statuses)
          │
          ├──────────────────▶  Pardot / Account Engagement (connected campaigns)
          │
          ├──────────────────▶  Airtable (per-decision audit log)
          │
          └──────────────────▶  Slack (a6 health alerts)
```

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Trigger.dev v4 for orchestration | Durable runs, automatic retries, checkpoint on long waits, dashboard visibility for non-technical owners |
| Polling (not webhooks) for intake | No always-on server needed; 5-minute latency is acceptable for campaign intake |
| All rules in `src/config/`, mirrored in Airtable | Non-technical owners can edit naming rules, routing, and checklists without touching code |
| `a5` as a hard gate in the orchestrator | Prevents Salesforce from being polluted with badly-named records under any circumstances |
| Sequential `triggerAndWait` — never `Promise.all` | Trigger.dev requirement; parallel waits on sub-tasks are unsupported and cause unexpected behavior |
| Claude for classification + correction | Handles the variability and ambiguity in free-text form submissions that regex alone cannot |
| Native `fetch` for all API clients | Avoids SDK version drift and keeps dependencies minimal; all three third-party APIs (Asana, SF, Pardot) expose stable REST endpoints |

---

## 3. Pipeline: Data Flow End-to-End

```
Asana form submitted
        │
        ▼
intake-poller (every 5 min)
  fetchNewSubmissions() → AsanaSubmission[]
  for each: intakePipeline.trigger({ asanaTaskId }, { idempotencyKey: "campaign-{id}" })
        │
        ▼
intake-pipeline (orchestrator)
        │
        ├─▶ a1-intake-triage
        │     Input:  { asanaTaskId }
        │     Reads:  Asana task fields (custom field GIDs → flat map)
        │     Calls:  Claude haiku → JSON classification
        │     Checks: confidence ≥ 0.7, no issues, schema valid
        │     Logs:   Airtable audit entry
        │     Output: { classification, owner, priority, confidence, needsHuman }
        │
        │   if needsHuman → STOP (returned to human for review)
        │
        ├─▶ a5-naming-enforcer  ← THE GATE
        │     Input:  { asanaTaskId, classification }
        │     Step 1: Deterministic regex validation of classification.campaignName
        │     Step 2: If invalid → buildCampaignName() from parts → validate again
        │     Step 3: If still invalid → Claude sonnet → refined correction
        │     Step 4: Post correction as Asana comment for regional owner to review
        │     Step 5: wait.forToken (24 h) — human approves or rejects
        │             [Currently: auto-approves for scaffold; TODO for production]
        │     Logs:   Airtable audit entry
        │     Output: { approved, approvedName, suggestedName?, reason? }
        │
        │   if !approved → STOP (Asana comment posted; name must be corrected)
        │
        ├─▶ a2-sf-campaign
        │     Input:  { asanaTaskId, approvedName, classification, owner }
        │     Step 1: createCampaign() → SF campaign (Name, Type, StartDate, Status, RecordTypeId)
        │     Step 2: addMemberStatuses() → one CampaignMemberStatus record per status in config
        │     Step 3: createConnectedCampaign() → Pardot campaign linked to SF campaign
        │     Logs:   Airtable audit entry
        │     Output: { sfCampaignId, pardotCampaignId? }
        │
        ├─▶ a3-asset-checklist
        │     Input:  { asanaTaskId, classification, sfCampaignId? }
        │     Reads:  ASSET_CHECKLISTS[type] from config
        │     Calls:  createSubtask() per asset (sequential)
        │     Posts:  summary comment to Asana
        │     Logs:   Airtable audit entry
        │     Output: { ok, subtasksCreated }
        │
        └─▶ a4-brief-drafting
              Input:  { asanaTaskId, classification, sfCampaignId? }
              Calls:  Claude sonnet → one-page brief (Objective/Audience/Messaging/KPIs/Assets/Timeline)
              Posts:  brief as Asana comment
              Logs:   Airtable audit entry
              Output: { ok, briefGenerated }

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Independent cron:

a6-sync-watchdog (daily 09:00 UTC)
  Queries SF for active campaigns with a Pardot connected campaign
  Compares SF vs Pardot member counts
  Flags divergence > 2 h → Slack alert
  Detects orphaned Pardot assets → Slack alert
  On Monday → weekly health report to Slack
```

---

## 4. Task Reference

### 4.1 intake-poller

| Property | Value |
|----------|-------|
| File | `src/trigger/intake-poller.ts` |
| Type | `schedules.task` |
| Cron | `*/5 * * * *` (every 5 minutes) |
| ID | `intake-poller` |

**What it does:**
Calls `fetchNewSubmissions()` which queries the Asana intake project for tasks. For each task found, it fires `intakePipeline.trigger()` with an idempotency key of `campaign-{asanaTaskId}`. The idempotency key is critical — if the same task appears in two consecutive 5-minute windows (e.g., because no cursor is stored yet), Trigger.dev deduplicates the run and does not process it twice.

**Idempotency key pattern:**
```
campaign-${asanaTaskId}
```

**Current limitation:** `fetchNewSubmissions()` returns all tasks in the project. A production implementation should store the last-processed timestamp or task GID in Airtable and pass it as a `modified_since` parameter to the Asana API to avoid re-querying already-processed tasks on every poll.

---

### 4.2 intake-pipeline (orchestrator)

| Property | Value |
|----------|-------|
| File | `src/trigger/intake-pipeline.ts` |
| Type | `task` |
| ID | `intake-pipeline` |
| Retry | `maxAttempts: 1` — individual tasks retry; the orchestrator does not |

**Payload:**
```typescript
{ asanaTaskId: string }
```

**Gate enforcement:**
The orchestrator checks `gate.approved` before calling `a2SfCampaign`. There is no path from a5 to a2 that bypasses this check. If `approved === false`, the function returns immediately with `{ stoppedAt: "a5" }`.

**Rule: no `Promise.all` on `triggerAndWait`:**
All four child-task invocations are sequential `await` calls. Trigger.dev does not support awaiting multiple `triggerAndWait` calls in parallel.

**Early-exit return shapes:**
```typescript
// a1 stopped it
{ stoppedAt: "a1", reason: string, asanaTaskId: string }

// a5 gate blocked it
{ stoppedAt: "a5", reason: string, suggestedName?: string, asanaTaskId: string }

// Full success
{ ok: true, asanaTaskId: string, sfCampaignId: string, approvedName: string }
```

---

### 4.3 a1 — Intake Triage

| Property | Value |
|----------|-------|
| File | `src/trigger/a1-intake-triage.ts` |
| Type | `schemaTask` |
| Schema | `TriagePayloadSchema` (`{ asanaTaskId: string }`) |
| ID | `a1-intake-triage` |
| Model | `claude-haiku-4-5` |
| Retry | `maxAttempts: 3, factor: 2, min: 2s, max: 30s` |

**What it does:**

1. **Fetches the Asana task** via `fetchTask(asanaTaskId)` — returns a flat `Record<string, string>` where keys are both the custom field GIDs and human-readable field names.

2. **Builds the triage prompt** via `buildTriagePrompt(fields)` in `src/ai/prompts.ts`. The prompt instructs Claude to return a JSON object with classification fields and a `confidence` float.

3. **Classifies with haiku** — the cheapest/fastest model, appropriate for structured extraction from a form.

4. **Two-stage validation:**
   - Stage 1: `RawTriageResponseSchema` (loose Zod schema) validates the raw JSON shape
   - Stage 2: `ClassificationSchema` (strict) validates the typed classification fields

5. **Confidence check:** if `confidence < 0.7` (the `CONFIDENCE_FLOOR` from `src/config/routing.ts`), sets `needsHuman: true`. Same if Claude returned issues or if schema parsing failed.

6. **Determines owner** from the region using `REGION_OWNERS` in `src/config/routing.ts`.

7. **Logs the decision** to Airtable — every AI decision is recorded per ticket.

**Output type:**
```typescript
{
  asanaTaskId:    string
  classification: Classification   // type, region, goLiveDate, quarter, campaignName, ...
  owner:          string           // "Harish" | "Aayushi" | "Felipe"
  priority:       "standard" | "urgent" | "needs-info"
  confidence:     number           // 0.0–1.0
  needsHuman:     boolean
  reason?:        string           // populated when needsHuman is true
}
```

**Escalation path:** If `classify()` (haiku) throws, the code falls back to `escalate()` (opus) for the same prompt before propagating the error.

---

### 4.4 a5 — Naming Enforcer (Gate)

| Property | Value |
|----------|-------|
| File | `src/trigger/a5-naming-enforcer.ts` |
| Type | `schemaTask` |
| Schema | `NamingPayloadSchema` (`{ asanaTaskId, classification }`) |
| ID | `a5-naming-enforcer` |
| Model | `claude-sonnet-4-6` (only when deterministic correction fails) |
| Retry | `maxAttempts: 2, factor: 2, min: 1s, max: 10s` |

**Naming convention (from §6.1):**
```
[Year]_[Region]_[Type]_[CampaignName]_[Quarter]
e.g.  2026_EMEA_Webinar_DrupalSecurity_Q3
```

| Segment | Constraint |
|---------|------------|
| Year | 4-digit integer matching go-live date's year |
| Region | One of: `AMER`, `EMEA`, `APJ`, `LATAM` |
| Type | One of: `Event`, `Webinar`, `Email`, `Paid`, `Content` |
| CampaignName | PascalCase, alphanumeric only, no spaces or separators |
| Quarter | `Q1`–`Q4` matching go-live date's calendar quarter |

**Decision tree:**

```
validateCampaignName(classification.campaignName)
    │
    ├─ valid → return { approved: true, approvedName: name }
    │
    └─ invalid
           │
           ├─ buildCampaignName(year, region, type, rawName, quarter)
           │       ↑ deterministic, sanitizes rawName to PascalCase
           │
           ├─ validateCampaignName(inferred name)
           │       ├─ valid → propose inferredName
           │       └─ invalid → Claude sonnet refines correction
           │
           ├─ validateCampaignName(Claude's suggestion)
           │       └─ still invalid → return { approved: false, reason: "..." }
           │
           ├─ addTaskComment() — posts original, issues, and suggestion to Asana
           │
           └─ wait.forToken (24 h) — [TODO: production; scaffold auto-approves]
                   ├─ approved → return { approved: true, approvedName: suggestion }
                   └─ timeout → return { approved: false, reason: "Approval timed out" }
```

**`validateCampaignName()` logic** (in `src/config/naming-rules.ts`):
- First tries the full regex: `^(\d{4})_(AMER|EMEA|APJ|LATAM)_(Event|Webinar|Email|Paid|Content)_([A-Z][A-Za-z0-9]+)_(Q[1-4])$`
- On failure, splits on `_` and checks each segment individually to produce specific issue messages

**`buildCampaignName()` sanitization:**
Splits `rawCampaignName` on spaces/underscores/hyphens, capitalizes first letter of each word, lowercases the rest, joins without separators. E.g., `"drupal security"` → `"DrupalSecurity"`.

**Output type:**
```typescript
{
  approved:      boolean
  approvedName?: string   // set when approved === true
  suggestedName?: string  // set when a correction was generated
  reason?:       string   // set when approved === false
}
```

---

### 4.5 a2 — Salesforce Campaign Build

| Property | Value |
|----------|-------|
| File | `src/trigger/a2-sf-campaign.ts` |
| Type | `schemaTask` |
| Schema | `SfCampaignPayloadSchema` |
| ID | `a2-sf-campaign` |
| Retry | `maxAttempts: 3, factor: 2, min: 5s, max: 60s` |

**Only reachable after a5 returns `{ approved: true }`.**

**Step 1 — Create SF Campaign:**
```
POST /services/data/v59.0/sobjects/Campaign
{
  Name:         approvedName,          // e.g. "2026_EMEA_Webinar_DrupalSecurity_Q3"
  Type:         classification.type,   // "Webinar"
  StartDate:    classification.goLiveDate,
  Status:       "Planned",
  IsActive:     true,
  RecordTypeId: SF_CAMPAIGN_RECORD_TYPE_ID,  // TODO(ground-truth)
  BudgetedCost: budget (parsed from string),
  Description:  "Region: EMEA\nGoal: ...\nAsana task: {asanaTaskId}"
}
```

**Step 2 — Apply Member Statuses:**
One `POST /sobjects/CampaignMemberStatus` per status in the type's list. The first status is marked `IsDefault: true`. Statuses where the prospect has "responded" (attended, clicked, downloaded, etc.) are marked `HasResponded: true`.

Member statuses by type (from `src/config/member-statuses.ts`):

| Type | Statuses |
|------|---------|
| Event | Registered, Attended, No Show, Walk-in, Booth Visit |
| Webinar | Registered, Attended, No Show, On-Demand View |
| Email | Sent, Opened, Clicked, Bounced, Unsubscribed |
| Paid | Impression, Clicked, Form Fill, Converted |
| Content | Downloaded, Viewed, Engaged, Converted |

**Step 3 — Create Pardot Connected Campaign:**
`POST https://pi.pardot.com/api/v5/objects/campaigns` with the SF campaign ID. Pardot failure is non-fatal — the SF campaign is kept, a warning is logged to Airtable, and the run continues.

**Output type:**
```typescript
{ sfCampaignId: string, pardotCampaignId?: string }
```

---

### 4.6 a3 — Asset Checklist

| Property | Value |
|----------|-------|
| File | `src/trigger/a3-asset-checklist.ts` |
| Type | `schemaTask` |
| Schema | `AssetChecklistPayloadSchema` |
| ID | `a3-asset-checklist` |
| Retry | `maxAttempts: 3, factor: 2, min: 2s, max: 30s` |

No AI required — the full asset list per type is defined in `src/config/asset-checklists.ts`. For each item, calls `createSubtask(asanaTaskId, assetName)` sequentially. Posts a summary comment to the Asana task listing all created subtasks.

**Asset counts by type:**

| Type | Asset items |
|------|------------|
| Event | 12 |
| Webinar | 10 |
| Email | 6 |
| Paid | 5 |
| Content | 5 |

---

### 4.7 a4 — Brief Drafting

| Property | Value |
|----------|-------|
| File | `src/trigger/a4-brief-drafting.ts` |
| Type | `schemaTask` |
| Schema | `BriefDraftingPayloadSchema` |
| ID | `a4-brief-drafting` |
| Model | `claude-sonnet-4-6` |
| Retry | `maxAttempts: 3, factor: 2, min: 2s, max: 30s` |

**Brief format (§6.6):**

```markdown
## Objective
## Audience
## Messaging
## KPIs
## Asset Plan
## Timeline
```

Inputs fed into the prompt: campaign name, type, region, quarter, go-live date, goal, audience, key message, budget, SF campaign ID.

Output is posted as an Asana comment on the intake task, prefixed with a header making it scannable. Target length: under 400 words.

**Pending:** Attaching the brief to the SF campaign via the SF ContentVersion / ContentDocumentLink API (requires `POST /sobjects/ContentVersion` with base64-encoded content, then linking to the campaign via `ContentDocumentLink`). Marked as `// TODO` in the file.

---

### 4.8 a6 — Sync Watchdog

| Property | Value |
|----------|-------|
| File | `src/trigger/a6-sync-watchdog.ts` |
| Type | `schedules.task` |
| Cron | `0 9 * * *` (daily 09:00 UTC) |
| ID | `a6-sync-watchdog` |

**Not part of the per-ticket pipeline.** Runs independently on a daily schedule.

**Daily logic:**
1. SOQL query: all active SF campaigns with a non-null `ConnectedCampaignId`
2. For each: compare `NumberOfContacts` (SF) vs Pardot prospect count
3. Divergence detected → Slack alert to `SLACK_ALERT_CHANNEL`
4. Campaigns missing a Pardot connected campaign → separate Slack alert

**Weekly logic (Mondays):**
Triggered by `new Date().getUTCDay() === 1` check inside the daily run. Posts a summary health report to Slack.

**Pending ground-truth:**
- Correct SF field name for the Pardot campaign ID (likely `ConnectedCampaignId` but needs verification)
- Pardot API v5 endpoint and response field for prospect/member counts

---

## 5. Configuration Modules

All rules that the MOps team edits live in `src/config/`. These values are the code-side source of truth; the Airtable tables are the human-editable mirror.

### `src/config/naming-rules.ts`

```typescript
VALID_REGIONS: ["AMER", "EMEA", "APJ", "LATAM"]
VALID_TYPES:   ["Event", "Webinar", "Email", "Paid", "Content"]
VALID_QUARTERS: ["Q1", "Q2", "Q3", "Q4"]
NAMING_PATTERN: /^(\d{4})_(AMER|EMEA|APJ|LATAM)_(Event|...)_([A-Z][A-Za-z0-9]+)_(Q[1-4])$/

validateCampaignName(name) → { valid, issues, parsed? }
buildCampaignName(year, region, type, rawName, quarter) → string
quarterFromDate(date) → "Q1" | "Q2" | "Q3" | "Q4"
```

### `src/config/routing.ts`

```typescript
REGION_OWNERS: { AMER: "Harish", EMEA: "Aayushi", APJ: "Aayushi", LATAM: "Felipe" }
ESCALATION_HOURS: 24
CONFIDENCE_FLOOR: 0.7
```

### `src/config/member-statuses.ts`

```typescript
MEMBER_STATUSES: Record<CampaignType, string[]>    // statuses to create
RESPONDED_STATUSES: Record<CampaignType, string[]> // which statuses set HasResponded: true
```

### `src/config/asset-checklists.ts`

```typescript
ASSET_CHECKLISTS: Record<CampaignType, string[]>   // asset names → Asana subtask names
```

---

## 6. AI Layer

### Model Tiering (`src/ai/claude.ts`)

| Function | Model | Max tokens | Use case |
|----------|-------|-----------|----------|
| `classify(prompt)` | `claude-haiku-4-5` | 1024 | Intake classification — fast, structured extraction |
| `reason(prompt, maxTokens?)` | `claude-sonnet-4-6` | 2048 | Naming corrections, brief drafting — default tier |
| `escalate(prompt, maxTokens?)` | `claude-opus-4-8` | 4096 | Fallback when haiku fails; ambiguous/high-stakes cases |

All three functions call the same `callClaude()` internal helper which:
- Creates an `Anthropic` client with `process.env.ANTHROPIC_API_KEY`
- Calls `messages.create()` with a single `user` turn
- Extracts the first content block; throws if it's not `type: "text"`

### Prompt Builders (`src/ai/prompts.ts`)

Prompt construction is entirely in `prompts.ts` — task files only call builders and pass results to `claude.ts`. This keeps prompt iteration isolated from task logic.

| Function | Used by | Purpose |
|----------|---------|---------|
| `buildTriagePrompt(rawFields)` | a1 | Instructs Claude to return structured JSON classification |
| `buildNamingCorrectionPrompt(name, classification, issues)` | a5 | Asks Claude to return only a corrected campaign name string |

### Schemas (`src/ai/schemas.ts`)

Zod schemas serve two purposes:
1. Runtime validation of Claude's JSON responses (never trust raw LLM output)
2. TypeScript types for task payloads via `schemaTask`

The `RawTriageResponseSchema` is intentionally loose (accepts `string | null` for optional fields) so that schema parse errors from Claude output don't mask the real issue. The `ClassificationSchema` is strict and is used for the actual typed `Classification` object passed between tasks.

---

## 7. Integration Clients

All API clients live in `src/lib/`. Tasks never call `fetch` directly.

### `src/lib/asana.ts` — Asana REST API v1

| Function | Asana endpoint | Purpose |
|----------|---------------|---------|
| `fetchNewSubmissions()` | `GET /projects/{gid}/tasks` | Poll for new intake tasks |
| `fetchTask(taskId)` | `GET /tasks/{id}` | Fetch a single task's full field set |
| `addTaskComment(taskId, text)` | `POST /tasks/{id}/stories` | Post naming correction / brief as comment |
| `createSubtask(parentId, name)` | `POST /tasks/{id}/subtasks` | Create one asset checklist subtask |
| `updateCustomField(taskId, fieldGid, value)` | `PUT /tasks/{id}` | Write back a classification result |

**Auth:** Bearer token from `ASANA_ACCESS_TOKEN` env var.

**Field normalization:** `flattenFields()` converts Asana's nested `custom_fields` array into a flat `Record<string, string>` keyed by both field GID and field name, so prompts can reference fields by human-readable name.

**Field GID placeholders** (all in `FIELD_GIDS` constant, need real values):
```
CAMPAIGN_NAME, CAMPAIGN_TYPE, REGION, GO_LIVE_DATE,
BUDGET, GOAL, AUDIENCE, KEY_MESSAGE, PARENT_PROGRAM_ID
```

### `src/lib/salesforce.ts` — Salesforce REST API v59.0

**Auth:** Username-password OAuth flow. Credentials: `SF_CLIENT_ID`, `SF_CLIENT_SECRET`, `SF_USERNAME`, `SF_PASSWORD`, `SF_SECURITY_TOKEN`. Token is cached in module scope for the task run lifetime.

| Function | Purpose |
|----------|---------|
| `createCampaign(params)` | `POST /sobjects/Campaign` → returns SF campaign ID |
| `addMemberStatuses(campaignId, statuses, responded)` | `POST /sobjects/CampaignMemberStatus` × N |

**Field API names** (confirmed defaults, verify against org):
```
Name, Type, Status, StartDate, EndDate, BudgetedCost, ParentId, RecordTypeId, Description, IsActive
```

### `src/lib/pardot.ts` — Pardot / Account Engagement API v5

**Auth:** Same Salesforce OAuth token (reuses `SF_USERNAME`/`SF_PASSWORD`). Business unit ID sent as `Pardot-Business-Unit-Id` header on every request.

| Function | Purpose |
|----------|---------|
| `createConnectedCampaign(sfCampaignId, name)` | Creates a Pardot campaign linked to the SF campaign |

### `src/lib/slack.ts` — Slack Web API

| Function | Purpose |
|----------|---------|
| `sendAlert(channel, text)` | `chat.postMessage` with plain text |
| `sendBlockMessage(channel, blocks)` | `chat.postMessage` with block kit |

**Auth:** Bearer token from `SLACK_BOT_TOKEN`.

### `src/lib/airtable.ts` — Airtable REST API

| Function | Purpose |
|----------|---------|
| `logDecision(asanaTaskId, entry)` | Appends one row to the audit log table |

**Audit entry fields:** Asana Task ID, Automation, Decision, Confidence, Model, Timestamp, Data (JSON string).

Every task calls `logDecision()` exactly once per run, creating a full per-ticket audit trail.

---

## 8. Schemas and Type System

### Payload schemas (used with `schemaTask`)

| Task | Schema | Key fields |
|------|--------|-----------|
| a1 | `TriagePayloadSchema` | `asanaTaskId` |
| a5 | `NamingPayloadSchema` | `asanaTaskId`, `classification` |
| a2 | `SfCampaignPayloadSchema` | `asanaTaskId`, `approvedName`, `classification`, `owner` |
| a3 | `AssetChecklistPayloadSchema` | `asanaTaskId`, `classification`, `sfCampaignId?` |
| a4 | `BriefDraftingPayloadSchema` | `asanaTaskId`, `classification`, `sfCampaignId?` |

### Core shared type: `Classification`

```typescript
{
  type:            "Event" | "Webinar" | "Email" | "Paid" | "Content"
  region:          "AMER" | "EMEA" | "APJ" | "LATAM"
  goLiveDate:      string   // YYYY-MM-DD
  quarter:         "Q1" | "Q2" | "Q3" | "Q4"
  campaignName:    string
  budget?:         string
  goal?:           string
  audience?:       string
  keyMessage?:     string
  parentProgramId?: string
}
```

This object flows from a1's output through the orchestrator into a5, a2, a3, and a4. It is the single typed representation of the intake form's data.

---

## 9. Trigger.dev Conventions

### Task types used

| Trigger.dev function | Used for |
|---------------------|----------|
| `task()` | `intake-pipeline` orchestrator |
| `schemaTask()` | a1, a2, a3, a4, a5 (payload validation at runtime) |
| `schedules.task()` | `intake-poller`, `a6-sync-watchdog` |

### `triggerAndWait` / `.unwrap()` pattern

```typescript
// CORRECT — sequential awaits with unwrap
const triage = await a1IntakeTriage.triggerAndWait({ asanaTaskId }).unwrap();
const gate   = await a5NamingEnforcer.triggerAndWait({ asanaTaskId, classification: triage.classification }).unwrap();
const build  = await a2SfCampaign.triggerAndWait({ ... }).unwrap();

// WRONG — never do this
await Promise.all([
  a1IntakeTriage.triggerAndWait({ ... }),
  a5NamingEnforcer.triggerAndWait({ ... }),
]);
```

`.unwrap()` throws on task failure, propagating the error to the orchestrator. This causes the orchestrator run to fail and be visible in the Trigger.dev dashboard.

### Idempotency keys

Every call that could be triggered more than once carries an idempotency key:

```typescript
intakePipeline.trigger({ asanaTaskId }, { idempotencyKey: `campaign-${asanaTaskId}` })
```

If the poller fires twice before the first run completes, the second trigger call is a no-op.

### Waits and checkpointing

Trigger.dev automatically checkpoints any wait longer than 5 seconds. During a `wait.forToken` pause (up to 24 hours for name approval), the task consumes zero compute. The run resumes from the checkpoint when the token is completed externally.

### Import extensions

All imports between TypeScript files in `src/` use `.js` extensions (required by Node ESM + NodeNext module resolution):

```typescript
import { a1IntakeTriage } from "./a1-intake-triage.js";
import { MEMBER_STATUSES } from "../config/member-statuses.js";
```

---

## 10. Environment Variables

Full list from `.env.example`:

| Variable | Used by | Description |
|----------|---------|-------------|
| `TRIGGER_SECRET_KEY` | Trigger.dev CLI | Project secret key |
| `ANTHROPIC_API_KEY` | `src/ai/claude.ts` | Anthropic API key |
| `ASANA_ACCESS_TOKEN` | `src/lib/asana.ts` | Personal access token |
| `ASANA_WORKSPACE_GID` | (future) | Workspace GID for user lookups |
| `ASANA_INTAKE_PROJECT_GID` | `src/lib/asana.ts` | GID of the intake form project |
| `SF_INSTANCE_URL` | `src/lib/salesforce.ts` | `https://login.salesforce.com` or MyDomain URL |
| `SF_CLIENT_ID` | `src/lib/salesforce.ts` | Connected App client ID |
| `SF_CLIENT_SECRET` | `src/lib/salesforce.ts` | Connected App client secret |
| `SF_USERNAME` | `src/lib/salesforce.ts` | SF user email |
| `SF_PASSWORD` | `src/lib/salesforce.ts` | SF user password |
| `SF_SECURITY_TOKEN` | `src/lib/salesforce.ts` | SF user security token (appended to password in OAuth) |
| `SF_CAMPAIGN_RECORD_TYPE_ID` | `src/lib/salesforce.ts` | 18-char Record Type ID for Campaign object |
| `PARDOT_CLIENT_ID` | `src/lib/pardot.ts` | Pardot OAuth client ID (defaults to `SF_CLIENT_ID`) |
| `PARDOT_CLIENT_SECRET` | `src/lib/pardot.ts` | Pardot OAuth client secret |
| `PARDOT_BUSINESS_UNIT_ID` | `src/lib/pardot.ts` | 18-char Account Engagement BU ID (`0Uv…`) |
| `SLACK_BOT_TOKEN` | `src/lib/slack.ts` | Bot OAuth token (`xoxb-…`) |
| `SLACK_ALERT_CHANNEL` | `src/trigger/a6-sync-watchdog.ts` | Channel ID for health alerts |
| `AIRTABLE_API_KEY` | `src/lib/airtable.ts` | Airtable personal access token |
| `AIRTABLE_BASE_ID` | `src/lib/airtable.ts` | Base ID from Airtable URL (`appXXXXXXXXXXXXXX`) |
| `AIRTABLE_AUDIT_TABLE_ID` | `src/lib/airtable.ts` | Table name or ID for the audit log |

---

## 11. Error Handling and Retries

### Per-task retry config

| Task | maxAttempts | Backoff |
|------|------------|---------|
| intake-poller | 1 (schedules default) | — |
| intake-pipeline | 1 | — |
| a1-intake-triage | 3 | 2×, 2s–30s |
| a5-naming-enforcer | 2 | 2×, 1s–10s |
| a2-sf-campaign | 3 | 2×, 5s–60s |
| a3-asset-checklist | 3 | 2×, 2s–30s |
| a4-brief-drafting | 3 | 2×, 2s–30s |
| a6-sync-watchdog | 1 (schedules default) | — |

### Error categories

| Category | Behavior |
|----------|----------|
| Network error (Asana/SF/Pardot/Slack) | Task throws → Trigger.dev retries with backoff |
| Claude returns non-JSON | a1 returns `needsHuman: true` with reason; no retry needed |
| Schema validation failure | a1 returns `needsHuman: true`; a5 returns `approved: false` |
| SF campaign creation fails | a2 throws → Trigger.dev retries (up to 3×) |
| Pardot creation fails | a2 catches the error, logs a warning to Airtable, and continues — SF campaign is not rolled back |
| Naming gate not approved | Orchestrator returns `{ stoppedAt: "a5" }` — not an error state |
| Triage confidence too low | Orchestrator returns `{ stoppedAt: "a1" }` — not an error state |

---

## 12. Security Model

- **Secrets:** All credentials are environment variables. `.env.example` contains only empty keys. No real credentials are in the repository.
- **API clients:** Every lib function reads its credential from `process.env` at call time and throws a descriptive error if the variable is missing.
- **Asana PAT scope:** Read tasks + write stories (comments) + write subtasks. No broader workspace permissions needed.
- **Salesforce Connected App:** Minimum required: `api` scope + Campaign object CRUD + CampaignMemberStatus CRUD.
- **Pardot:** `pardot_api` scope via the same Salesforce OAuth flow.
- **No hardcoded values:** All org-specific values (record type IDs, field GIDs, business unit IDs) are in environment variables or `// TODO(ground-truth):` placeholder constants in the source.

---

## 13. Deployment

### Local development

```bash
cp .env.example .env      # fill in credentials
npm install
npm run dev               # starts Trigger.dev dev server; tasks register automatically
```

The dev server hot-reloads on file changes. Trigger runs can be fired manually from the Trigger.dev dashboard or CLI.

### Production deploy

```bash
npm run deploy
```

Bundles all tasks in `src/trigger/` and registers them with the Trigger.dev cloud. The `trigger.config.ts` specifies `dirs: ["src/trigger"]` which controls auto-discovery.

### First live run — recommended approach

1. Deploy to Trigger.dev with `ASANA_INTAKE_PROJECT_GID` pointing to a **test project** (not the live intake form).
2. Manually trigger `intake-pipeline` from the dashboard with a known test task ID.
3. Verify the run log: a1 classifies, a5 validates/corrects, a2 creates a sandbox SF campaign.
4. Only after a successful end-to-end test run, switch `ASANA_INTAKE_PROJECT_GID` to the live project.
5. Keep `wait.forToken` enabled in a5 so the first live SF writes require human approval.

---

## 14. Ground-Truth TODO List

These values cannot be inferred from training data and must be confirmed against the live org. Each is marked with `// TODO(ground-truth):` in the source file.

| # | Constant | File | Where to find it |
|---|----------|------|-----------------|
| 1 | `INTAKE_PROJECT_GID` | `src/lib/asana.ts` | Asana URL: `app.asana.com/0/{GID}/...` |
| 2 | `FIELD_GIDS.CAMPAIGN_NAME` | `src/lib/asana.ts` | `GET /projects/{gid}/custom_field_settings` |
| 3 | `FIELD_GIDS.CAMPAIGN_TYPE` | `src/lib/asana.ts` | Same endpoint as above |
| 4 | `FIELD_GIDS.REGION` | `src/lib/asana.ts` | Same endpoint |
| 5 | `FIELD_GIDS.GO_LIVE_DATE` | `src/lib/asana.ts` | Same endpoint |
| 6 | `FIELD_GIDS.BUDGET` | `src/lib/asana.ts` | Same endpoint |
| 7 | `FIELD_GIDS.GOAL` | `src/lib/asana.ts` | Same endpoint |
| 8 | `FIELD_GIDS.AUDIENCE` | `src/lib/asana.ts` | Same endpoint |
| 9 | `FIELD_GIDS.KEY_MESSAGE` | `src/lib/asana.ts` | Same endpoint |
| 10 | `FIELD_GIDS.PARENT_PROGRAM_ID` | `src/lib/asana.ts` | Same endpoint |
| 11 | `SF_CAMPAIGN_RECORD_TYPE_ID` | env var + `src/lib/salesforce.ts` | SF Setup → Object Manager → Campaign → Record Types → copy 18-char ID |
| 12 | `SF_FIELDS.BUDGET` (`BudgetedCost`) | `src/lib/salesforce.ts` | SF Setup → Object Manager → Campaign → Fields — confirm API name |
| 13 | `SF_PARDOT_CAMPAIGN_ID_FIELD` | `src/trigger/a6-sync-watchdog.ts` | SF Setup → Object Manager → Campaign → Fields — look for `ConnectedCampaignId` or custom |
| 14 | `PARDOT_BUSINESS_UNIT_ID` | env var + `src/lib/pardot.ts` | Account Engagement → Settings → Business Unit Setup (18-char `0Uv…` ID) |
| 15 | Pardot member-count field | `src/trigger/a6-sync-watchdog.ts` | Pardot API v5 docs — campaign object response fields |
| 16 | `AIRTABLE_BASE_ID` | env var + `src/lib/airtable.ts` | Airtable URL: `airtable.com/{BASE_ID}/...` |
| 17 | `AIRTABLE_AUDIT_TABLE_ID` | env var + `src/lib/airtable.ts` | Airtable table name or ID for the audit log |
| 18 | `SLACK_ALERT_CHANNEL` | env var + `a6-sync-watchdog.ts` | Slack channel ID (starts with `C`) |

**Priority order for ground-truth collection:**
1. Items 1–10 (Asana field GIDs) — needed before a1 can classify real submissions
2. Items 11–12 (SF) — needed before a2 can create campaigns
3. Items 14–15 (Pardot) — needed before a2 can create connected campaigns and a6 can compare counts
4. Items 16–18 (Airtable, Slack) — needed for audit log and watchdog alerts

---

## 15. Repository Structure

```
c:\Users\lebdi\Mops CC Project\
│
├── MOps.md                          # Project memory — single source of truth
├── trigger-ref.md                   # Trigger.dev v4 API reference
├── TECHNICAL.md                     # This document
├── trigger.config.ts                # Trigger.dev project config (dirs, runtime, logLevel)
├── package.json                     # ESM, dependencies: @trigger.dev/sdk, @anthropic-ai/sdk, zod
├── tsconfig.json                    # NodeNext module, strict, skipLibCheck
├── .env.example                     # All required env vars (empty values)
│
├── src/
│   ├── trigger/                     # Auto-discovered by Trigger.dev
│   │   ├── intake-poller.ts         # schedules.task — polls Asana every 5 min
│   │   ├── intake-pipeline.ts       # task — orchestrator: a1 → a5 → a2 → a3 → a4
│   │   ├── a1-intake-triage.ts      # schemaTask — Claude haiku classification
│   │   ├── a2-sf-campaign.ts        # schemaTask — SF + Pardot campaign creation
│   │   ├── a3-asset-checklist.ts    # schemaTask — Asana subtask generation
│   │   ├── a4-brief-drafting.ts     # schemaTask — Claude sonnet brief drafting
│   │   ├── a5-naming-enforcer.ts    # schemaTask — naming gate (THE gate)
│   │   └── a6-sync-watchdog.ts      # schedules.task — daily Pardot/SF sync check
│   │
│   ├── lib/                         # API clients — tasks never call fetch directly
│   │   ├── asana.ts                 # Asana REST v1 (fetch + PAT)
│   │   ├── salesforce.ts            # Salesforce REST v59 (OAuth username-password)
│   │   ├── pardot.ts                # Pardot/AE API v5 (SF OAuth + BU header)
│   │   ├── slack.ts                 # Slack Web API (chat.postMessage)
│   │   └── airtable.ts              # Airtable REST (audit log)
│   │
│   ├── ai/
│   │   ├── claude.ts                # Anthropic SDK wrapper + model tiering
│   │   ├── prompts.ts               # Prompt builders (no logic in tasks)
│   │   └── schemas.ts               # Zod schemas for payloads + Claude output validation
│   │
│   └── config/                      # Editable rules — never hardcode in tasks
│       ├── naming-rules.ts          # Convention regex, validator, builder
│       ├── routing.ts               # Region → owner, confidence floor, escalation hours
│       ├── member-statuses.ts       # Per-type SF member status lists
│       └── asset-checklists.ts      # Per-type Asana subtask lists
│
└── e2e/
    └── intake.spec.ts               # Playwright e2e — submit form, assert pipeline (TODO)
```
