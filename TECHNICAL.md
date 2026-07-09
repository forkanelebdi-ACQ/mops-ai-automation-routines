# MOps AI Automation — Technical Reference

> Complete technical breakdown of the system: architecture, data flow, pipeline stages,
> integration contracts, configuration rules, and deployment guide.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Architecture](#2-architecture)
3. [Pipeline: Data Flow End-to-End](#3-pipeline-data-flow-end-to-end)
4. [Pipeline Stage Reference](#4-pipeline-stage-reference)
   - [a1 — Intake Triage](#41-a1--intake-triage)
   - [a5 — Naming Enforcer (Gate)](#42-a5--naming-enforcer-gate)
   - [a2 — Salesforce Campaign Build](#43-a2--salesforce-campaign-build)
   - [a3 — Asset Checklist](#44-a3--asset-checklist)
   - [a4 — Brief Drafting](#45-a4--brief-drafting)
   - [a6 — Sync Watchdog](#46-a6--sync-watchdog)
   - [Seed Backlog — One-Time Setup](#47-seed-backlog--one-time-setup-not-a-recurring-stage)
5. [Configuration Modules](#5-configuration-modules)
6. [API Scripts](#6-api-scripts)
7. [Self-Correcting Behavior](#7-self-correcting-behavior)
8. [Environment Variables](#8-environment-variables)
9. [Error Handling](#9-error-handling)
10. [Security Model](#10-security-model)
11. [Deployment and Routines](#11-deployment-and-routines)
12. [Ground-Truth TODO List](#12-ground-truth-todo-list)
13. [Repository Structure](#13-repository-structure)

---

## 1. System Overview

### Problem

The MOps team is the manual integration layer between four systems that do not talk to each other:

```
Asana intake form  →  (human reads + re-keys)  →  Asana task  →  Salesforce  →  Pardot
```

Every campaign request requires a person to:
1. Read the form submission and classify the campaign
2. Validate the campaign name against the naming convention
3. Create the Salesforce campaign with the right type, dates, budget, and member statuses
4. Create subtasks in Asana for every required asset
5. Draft a campaign brief
6. Periodically check that Pardot and Salesforce member counts stay in sync

This takes 75–115 minutes per campaign and is error-prone.

### Solution

From a single Asana form submission, the system automatically:
- Filters out non-intake tasks and gates on completeness before touching classification
- Classifies the intake using Claude AI (type, subtype, region, targeting)
- Generates and confirms the campaign name (with human approval)
- Builds the complete Salesforce campaign spec — including member-status scaffolding and AM
  territory targeting — for the SF admin to create manually (Claude Code has read-only SF access)
- Runs a send-calendar conflict check, then creates all required Asana subtasks from the
  per-type (or per-subtype) asset checklist
- Drafts a one-page campaign brief and posts it to both the Asana task and Slack
- Monitors daily that Pardot and Salesforce member counts remain in sync

> A separate, one-time `routines/seed-backlog.md` routine is run once before go-live to freeze
> the pre-existing Asana backlog so the hourly pipeline only processes new submissions (§4.7).

---

## 2. Architecture

### Component Map

```
┌─────────────────────────────────────────────────────────────┐
│                   Claude Code Cloud Routines                │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  intake-pipeline routine (every hour)                │  │
│  │                                                      │  │
│  │  Claude agent reads routines/intake-pipeline.md      │  │
│  │  Uses Asana MCP → classifies → generates name →      │  │
│  │  runs scripts/ → builds SF campaign spec → creates   │  │
│  │  subtasks → drafts brief                             │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  sync-watchdog routine (daily 09:00 UTC)             │  │
│  │                                                      │  │
│  │  Compares Pardot vs SF member counts                 │  │
│  │  Alerts on divergence — Monday weekly report         │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
          │                            │
          ▼                            ▼
   ┌─────────────┐            ┌──────────────────────┐
   │    Asana    │            │  Claude Sonnet 4.6   │
   │  (MCP —    │            │  reasoning + self-   │
   │  tasks,    │            │  correction built in │
   │  subtasks, │            └──────────────────────┘
   │  comments) │
   └─────────────┘
          │
          ├──────────────────▶  Salesforce (scripts/salesforce.mjs)
          │
          ├──────────────────▶  Pardot / Account Engagement (scripts/pardot.mjs)
          │
          ├──────────────────▶  Google Sheets — per-decision audit log (scripts/sheets.mjs)
          │
          └──────────────────▶  Slack — health alerts (scripts/slack.mjs)
```

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Claude Code routines for orchestration | No infrastructure to manage; self-correcting behavior built into Claude's reasoning |
| Asana MCP for Asana operations | Native authenticated integration; no PAT code needed in the agent |
| Plain `.mjs` scripts for other APIs | No npm dependencies; Node 18+ native fetch handles all REST calls |
| `src/config/` files as reference | Claude reads these on each run; non-technical owners can understand the rules |
| a5 as a hard gate in the routine prompt | Explicit instruction prevents SF pollution under any circumstance |
| State file for idempotency | `state/processed-tasks.json` prevents double-processing same Asana task |
| Hourly polling (not webhooks) | No always-on server needed; hourly latency is acceptable for campaign intake |

---

## 3. Pipeline: Data Flow End-to-End

```
Asana form submitted
        │
        ▼
intake-pipeline routine (every hour)
  Claude reads state/processed-tasks.json
  Asana MCP fetches tasks from intake project
  Intake-form filter: keep only tasks with a non-empty "What are you Requesting?" field,
    no parent task, not marked complete — everything else is skipped silently
  For each unprocessed task:
        │
        ├─▶ a1: Completeness gate + classify
        │     Checks 8 required intake fields; if any are missing →
        │       Asana comment + status "incomplete requirements" → state "incomplete-requirements" → skip
        │     Reads Asana task fields via MCP
        │     Classifies: type, subtype, region, account-type/business-segment targets, confidence
        │     If confidence < 0.7 → post Asana comment + Slack alert → skip
        │
        │   (only continues if confidence ≥ 0.7)
        │
        ├─▶ a5: Generate name  ← HARD GATE
        │     Builds type_subtype_region_description_year_quarter from classification fields
        │     Posts to Asana for owner approval → wait for "approved" reply
        │     If no reply: escalate after 24h, or immediately if business days to go-live
        │       are within SLA_ESCALATION_DAYS[type]
        │     If no reply yet → skip task this run
        │
        │   (only continues after name approved)
        │
        ├─▶ a2: SF campaign spec (read-only)
        │     node scripts/salesforce.mjs find-campaign --name "..."
        │     If found → reuse existing SF Campaign ID, skip straight to a3
        │     If not found → resolve AM territories (getAmTerritoriesForCampaign), post the
        │       SF spec as an Asana comment, DM Felipe a segmentation brief (scripts/slack.mjs dm)
        │     Poll next runs for an 18-char SF Campaign ID in comments; verify with
        │       node scripts/salesforce.mjs find-campaign --id "701..."
        │     Escalate after 24h, or immediately if within SLA_ESCALATION_DAYS[type]
        │
        ├─▶ a3: Calendar check + asset checklist
        │     node scripts/sheets.mjs check-calendar — Tuesday block, 3-email/7-day limit,
        │       48h overlap warning; blocks on conflicts (Asana comment, do not proceed)
        │     node scripts/sheets.mjs log-send once clear
        │     Reads asset-checklists.ts (getAssetChecklist) for campaign type/subtype
        │     Asana MCP creates one subtask per asset
        │     Posts summary comment to Asana
        │
        ├─▶ a4: Brief drafting
        │     Claude writes brief (Objective/Audience/Messaging/KPIs/Assets/Timeline)
        │     Posts as Asana comment (system of record) AND via scripts/slack.mjs send to #mops-team
        │
        └─▶ Log + update state
              node scripts/sheets.mjs log
              Writes completed task ID to state/processed-tasks.json
              Sets Asana task status to "completed"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Independent routine:

sync-watchdog (daily 09:00 UTC)
  node scripts/salesforce.mjs query-campaigns
  For each: node scripts/pardot.mjs get-member-count
  Divergence → node scripts/slack.mjs alert
  Orphans    → node scripts/slack.mjs alert
  Monday     → weekly health report via Slack

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
One-time setup routine (run once, before go-live, never scheduled):

seed-backlog
  Asana MCP fetches all incomplete tasks from the intake project
  Any task not already in state → { id, status: "pre-existing-skip" }
  Writes state/processed-tasks.json — the hourly pipeline skips these forever
```

---

## 4. Pipeline Stage Reference

### 4.1 a1 — Intake Triage

**Filter (before a1 even starts, STEP 1 of the routine):**
Only a task with a non-empty "What are you Requesting?" custom field, no parent task, and not
marked complete is processed. Anything else is skipped silently — no comment, no state entry.
This exists specifically so the pipeline does not fire on report requests, list uploads, or
template sub-tasks living in the same Asana project.

**Sub-step 1 — Completeness gate:**
Before any classification, Claude checks 8 required intake fields against the task's custom
fields and description:

| Required field           | When required                              |
|---------------------------|---------------------------------------------|
| Subject Line / Preheader  | Email, Webinar, Event (invite series)       |
| Banners / creative link   | All types                                    |
| Content Copy              | All types                                    |
| URLs                       | All types                                    |
| Audience Segmentation     | All types                                    |
| Date(s)                    | All types                                    |
| Send Time(s)               | Email, Webinar, Event                       |
| Exclusion List(s)          | All types                                    |

If anything required is missing: post an Asana comment listing the missing fields, set the Asana
status to `incomplete requirements`, record `{ id, status: "incomplete-requirements",
missingFields: [...] }` in state, and **stop** — classification and a5 never run for this task.

**Sub-step 2 — Classify:**
Reads the Asana task fields using the Asana MCP and classifies the campaign.

**Classification fields:**
- `type` + `subtype`: mapped from the "What are you Requesting?" field to the 6-type / 35-subtype
  taxonomy in `src/config/naming-rules.ts` (`Demand Gen`, `Email`, `Event`, `Operational`,
  `Social`, `Web`)
- `region`: one of `AMER`, `EMEA`, `APJ`, `LATAM` (never defaulted — left unknown with a penalty
  if signals are absent or contradictory); `ALL` is a valid naming-segment region for global
  campaigns but is not an a1 classification outcome
- `go_live_date` / `quarter`: `Q1`–`Q4` derived from the proposed due date
- `goal`, `audience`, `key_message`, `budget`: extracted from free-text notes
- `account_type_target`: one of `Prospect`, `Customer`, `Partner`, `Former Customer`, `All`
- `business_segment_target`: one of `Enterprise`, `Mid-Market`, `Growth`, `Public Sector`, `All Segments`
- `owner`: from `src/config/routing.ts` (`REGION_OWNERS`) based on region
- `confidence`: 1.0 minus penalties (type unmapped −0.30, subtype ambiguous −0.15, region
  undetermined −0.20, go-live date missing −0.20, goal/audience/key_message each missing −0.10)

**Self-correction:** If any field is ambiguous, Claude re-reads the full task description before assigning a low confidence score.

**If confidence < `CONFIDENCE_FLOOR` (0.7):**
- Posts Asana comment flagging the unclear fields and tagging the regional owner
- Sets Asana status to `needs information`
- Sends Slack alert (`scripts/slack.mjs alert`)
- Records task as `flagged` in state
- Does NOT continue to a5

---

### 4.2 a5 — Naming Enforcer (Gate)

**Naming convention:**
```
type_subtype_region_description_year_quarter
Example: evt_ws_all_dam workshop boston_2026_q3
```
All 6 segments lowercase; `type`/`subtype` use the abbreviations in `src/config/naming-rules.ts` →
`TAXONOMY` (6 top-level types, 35 subtypes total). `region` is `amer`/`emea`/`apj`/`latam`/`all`.
`description` is 2–5 lowercase words Claude drafts from `key_message`, `goal`, and `title`.

> This replaced the earlier `[Year]_[Region]_[Type]_[CampaignName]_[Quarter]` convention (types:
> Event, Webinar, Email, Paid, Content) under the 2026 taxonomy revision. There is no
> `validateCampaignName` regex validator in the current codebase — a5 always **generates** the
> name from classification fields; it never validates a name supplied at intake.

**Flow:**
```
a5 (always runs after a1 confidence ≥ 0.7 — there is no pre-existing name to validate)
    │
    ├─ build name: [typeAbbr]_[subtypeAbbr]_[region]_[description]_[year]_[quarter]
    ├─ post to Asana: "📛 `[generatedName]` — reply 'approved' or suggest a revised description"
    ├─ set Asana status to "approval"; state → { status: "pending-approval", suggestedName }
    │
    └─ on later runs, poll comments for a reply
            ├─ "approved" found → state → "approval-received" → proceed to a2
            ├─ revised description → rebuild (same type/subtype/region/year/quarter) → re-post → re-poll
            └─ no reply yet
                    ├─ business days to go-live ≤ SLA_ESCALATION_DAYS[type] → escalate immediately
                    ├─ else if > 24h since posted → Slack escalation alert
                    └─ else → skip, poll again next run
```

**Hard gate:** a2 never runs unless a5 has explicitly recorded `approval-received`. This is enforced in the routine prompt instructions.

---

### 4.3 a2 — Salesforce Campaign Build (read-only spec + polling)

Only reached after a5 records `approval-received`.

> **Claude Code has READ-ONLY Salesforce access.** It never calls `create-campaign` or
> `add-member-statuses` — those exist in `scripts/salesforce.mjs` but are legacy/manual-test-only
> commands for a human to run locally (see README). The live routine only calls `find-campaign`.

**Step 1 — Check for an existing campaign:**
```bash
node scripts/salesforce.mjs find-campaign --name "[approvedName]"
```
- `{ found: true, sfCampaignId }` → reuse the ID, set Asana status to `in a sprint`, state →
  `pending-sf-creation`, skip straight to a3 (no spec comment, no Felipe DM).
- `{ found: false }` → proceed to Step 2.

**Step 2 — Resolve AM territories:**
```
getAmTerritoriesForCampaign(region, business_segment_target, industry?)
```
(`src/config/routing.ts`) intersects `SEGMENT_AM_TERRITORY_GROUPS[segment]` with
`REGION_AM_TERRITORIES[region]`, narrows further to the Public Sector group when the audience is
`Government - Federal` / `Government - State/Local`, and falls back to the full region list when
the segment is `All Segments` or the intersection is empty.

**Step 3 — Post the SF campaign spec as an Asana comment**, including name, type, region, dates,
budget, owner, account-type/business-segment targeting context, the resolved AM territory list,
and the member-status list from `getMemberStatuses(type, subtype)` (`src/config/member-statuses.ts`,
see table below). Instructs the SF admin to create the campaign manually, reply with the 18-char
Campaign ID (starts with `701`), and link the Pardot Connected Campaign in Account Engagement.

**Step 4 — DM Felipe (`SEGMENTATION_OWNER`) a segmentation brief:**
```bash
node scripts/slack.mjs dm --message "📊 Segmentation brief — [approvedName] ..."
```
Includes the same targeting context (account type, business segment, AM territories) so Felipe
can build the target list and confirm audience filters in Pardot before go-live.

**Step 5 — Set Asana status to `in a sprint`; state → `pending-sf-creation`.**

**Polling (subsequent runs, state = `pending-sf-creation`):** scan comments for an 18-char SF
Campaign ID.
```bash
node scripts/salesforce.mjs find-campaign --id "[sfCampaignId]"
```
- Found and name matches → proceed to a3.
- Found but name mismatched → comment + Slack alert, stay `pending-sf-creation`.
- Not found → comment asking for a correct ID, stay `pending-sf-creation`.
- No ID yet → escalate immediately if business days to go-live ≤ `SLA_ESCALATION_DAYS[type]`,
  else escalate if `specPostedAt` is > 24h old, else skip and poll again next run.

Member statuses by type (from `src/config/member-statuses.ts`, via `getMemberStatuses`):

| Type | Statuses |
|------|---------|
| Demand Gen | Impression, Clicked, Form Fill, Converted |
| Email | Sent, Opened, Clicked, Bounced, Unsubscribed |
| Event | Registered, Attended, No Show, Walk-in, Booth Visit |
| Event → **Webinar** (subtype override) | Registered, Attended, No Show, On-Demand View |
| Operational | Sent, Delivered, Failed |
| Social | Impression, Clicked, Engaged, Converted |
| Web | Viewed, Downloaded, Engaged, Converted |

**Pardot Connected Campaign:** created manually by the SF admin in Account Engagement, per the
spec-comment instructions — not called automatically by any routine. `scripts/pardot.mjs
create-campaign` exists but is not part of the live flow.

---

### 4.4 a3 — Calendar Check + Asset Checklist

**Sub-step 1 — Send calendar conflict check** (runs before the checklist, on every task):
```bash
node scripts/sheets.mjs check-calendar --date "[goLiveDate]" --type "[type]" --segment "[business_segment_target]"
```
Returns `{ conflicts: [], warnings: [] }`. Rules enforced (against the `SendCalendar` Google
Sheet):
- **Tuesday block** — Tuesdays are reserved for Welcome Nurture; any other type on a Tuesday is a conflict.
- **3-email/7-day limit** — max 3 Email-type sends to the same segment in any 7-day window.
- **48-hour audience-overlap warning** — non-blocking; flags another campaign hitting the same segment within 48h.

If `conflicts` is non-empty: post an Asana comment listing them, leave state unchanged, and do
**not** create the asset checklist until the requester replies `calendar-cleared`. If clear,
register the send:
```bash
node scripts/sheets.mjs log-send --date "[goLiveDate]" --type "[type]" --segment "[business_segment_target]" --campaign "[approvedName]"
```

**Sub-step 2 — Asset checklist:** largely config-driven. Reads `src/config/asset-checklists.ts`
via `getAssetChecklist(type, subtype)` — some subtypes (e.g. Webinar) override the type-level
default — then uses the Asana MCP to create one subtask per asset item under the intake task.

**Asset counts by type:**

| Type | Asset items |
|------|------------|
| Demand Gen | 5 |
| Email | 6 |
| Event | 12 |
| Event → **Webinar** (subtype override) | 10 |
| Operational | 3 |
| Social | 5 |
| Web | 5 |

Posts a summary comment to the Asana task listing everything created; appends any non-blocking
calendar warnings from sub-step 1.

---

### 4.5 a4 — Brief Drafting

Claude writes a one-page campaign brief using all intake data:

```markdown
## Objective
## Audience
## Messaging
## KPIs
## Asset Plan
## Timeline
```

**Self-correction:** Claude verifies all 6 sections are present before posting. If any is missing, it adds it.

Posts the brief as an Asana comment labeled as auto-generated (Asana is the system of record),
under 400 words, **and** sends it to Slack `#mops-team` via `scripts/slack.mjs send`. Both posts
happen — the brief is never Slack-only or Asana-only.

---

### 4.6 a6 — Sync Watchdog

**Not part of the per-ticket pipeline.** Runs independently daily at 09:00 UTC.

1. `node scripts/salesforce.mjs query-campaigns` — all active SF campaigns with a Pardot link
2. For each: `node scripts/pardot.mjs get-member-count` — compare SF vs Pardot counts
3. Any delta → `node scripts/slack.mjs alert` per campaign
4. Campaigns with no Pardot link → orphan alert
5. Monday only → weekly health report to Slack

Tracks recurring issues in `state/watchdog-history.json`. If the same campaign diverges for 3+ consecutive days, escalates with a higher-severity alert.

---

### 4.7 Seed Backlog — One-Time Setup (not a recurring stage)

`routines/seed-backlog.md` is **not** one of the six automations and is **not scheduled**. It
runs exactly once, before the intake pipeline first goes live, to freeze the pre-existing Asana
backlog:

1. Read `state/processed-tasks.json` (or treat as `[]`).
2. Asana MCP `get_tasks` on the intake project (`1205660951274722`), filtered to incomplete tasks.
3. For every task GID not already in state, add `{ id, status: "pre-existing-skip" }`.
4. Write the merged array back to `state/processed-tasks.json` and print a summary.

STEP 1 of `routines/intake-pipeline.md` checks for `pre-existing-skip` and skips those tasks
forever — this is what allows the hourly pipeline to only process tasks created after the seed
run. Running it a second time is harmless but pointless (it only ever adds entries for tasks not
already tracked).

---

## 5. Configuration Modules

All rules live in `src/config/`. Claude reads these on each run.

### `src/config/naming-rules.ts`

```typescript
TAXONOMY: {
  "Demand Gen": { abbr: "dg",  subtypes: { "Direct Mail": "dm", "Display Ad": "disp", ... } },
  "Email":      { abbr: "em",  subtypes: { "Newsletter": "nwsl", "Nurture": "nur", ... } },
  "Event":      { abbr: "evt", subtypes: { "Workshop": "ws", "Webinar": "wbr", ... } },
  "Operational":{ abbr: "ops", subtypes: { "Operational": "ops" } },
  "Social":     { abbr: "soc", subtypes: { "Organic Social": "org", "Paid Social": "paid" } },
  "Web":        { abbr: "web", subtypes: { "Organic": "org", "Demo": "demo", ... } },
}                                          // 6 top-level types, 35 subtypes total
VALID_REGIONS:  ["AMER", "EMEA", "APJ", "LATAM", "ALL"]
VALID_QUARTERS: ["q1", "q2", "q3", "q4"]

getTypeAbbr(type) → string
getSubtypeAbbr(type, subtype) → string | undefined
buildCampaignName(type, subtype, region, description, year, quarter) → string
  // "[typeAbbr]_[subtypeAbbr]_[region]_[description]_[year]_[quarter]", all lowercase
quarterFromDate(date) → "q1" | "q2" | "q3" | "q4"
```
There is no `validateCampaignName` / regex validator in the current module — names are always
generated by `buildCampaignName`, never validated against a pattern.

### `src/config/routing.ts`

```typescript
REGION_OWNERS:              { AMER: "Harish", EMEA: "Aayushi", APJ: "Aayushi", LATAM: "Felipe" }
REGION_AM_TERRITORIES:      Record<Region, string[]>       // AM territories reachable per region
SEGMENT_AM_TERRITORY_GROUPS: Partial<Record<BusinessSegment, string[]>>  // narrows by segment
BUSINESS_SEGMENTS:  ["Enterprise", "Mid-Market", "Growth", "Public Sector", "All Segments"]
ACCOUNT_TYPE_TARGETS: ["Prospect", "Customer", "Partner", "Former Customer", "All"]
SEGMENTATION_OWNER: "Felipe"          // DM'd a targeting brief on every new SF spec
CONFIDENCE_FLOOR:   0.7
SLA_ESCALATION_DAYS: { Event: 7, Email: 5, "Demand Gen": 5, Web: 4, Social: 4, Operational: 3 }
  // business days; Webinar inherits the Event threshold via its subtype (no separate key)

getOwner(region) → string
getAmTerritories(region) → string[]                       // legacy, region-only
getAmTerritoriesForCampaign(region, segment, industry?) → string[]
  // intersects SEGMENT_AM_TERRITORY_GROUPS[segment] with REGION_AM_TERRITORIES[region];
  // narrows to Public Sector group when industry is Government - Federal/State-Local;
  // falls back to the region list when segment is "All Segments" or intersection is empty
```

### `src/config/member-statuses.ts`

```typescript
MEMBER_STATUSES:            Record<CampaignType, string[]>       // statuses per top-level type
RESPONDED_STATUSES:         Record<CampaignType, string[]>       // which set HasResponded: true
MEMBER_STATUS_SUBTYPE_OVERRIDES:    { Webinar: [...] }           // overrides MEMBER_STATUSES
RESPONDED_STATUS_SUBTYPE_OVERRIDES: { Webinar: [...] }           // overrides RESPONDED_STATUSES

getMemberStatuses(type, subtype?) → string[]     // subtype override, else type default
getRespondedStatuses(type, subtype?) → string[]  // subtype override, else type default
```

### `src/config/asset-checklists.ts`

```typescript
ASSET_CHECKLISTS:                  Record<CampaignType, string[]>  // asset names per top-level type
ASSET_CHECKLIST_SUBTYPE_OVERRIDES: { Webinar: [...] }               // overrides ASSET_CHECKLISTS

getAssetChecklist(type, subtype?) → string[]     // subtype override, else type default
```

---

## 6. API Scripts

All scripts in `scripts/` are plain Node.js ES modules. No npm dependencies — native `fetch` only.

Each script:
- Loads `.env` from the project root at startup
- Accepts commands and `--flag value` arguments via `process.argv`
- Outputs JSON to stdout: `{ ...result }` on success or `{ error: "..." }` on failure
- Exits with code 0 on success, 1 on failure

### `scripts/salesforce.mjs`

| Command | What it does | Called by the live routines? |
|---------|-------------|-------------------------------|
| `find-campaign --name/--id` | `GET /sobjects/Campaign/{id}` or SOQL by exact name → `{ found, sfCampaignId, name }` | Yes — a2 (existence check + ID verification) |
| `query-campaigns` | SOQL query for active campaigns with a Pardot link → returns array | Yes — a6 sync watchdog |
| `create-campaign` | OAuth token → `POST /sobjects/Campaign` → returns `{ sfCampaignId }` | **No** — legacy/manual-test-only; a2 is read-only and never calls this |
| `add-member-statuses` | One `POST /sobjects/CampaignMemberStatus` per status for the campaign type/subtype | **No** — legacy/manual-test-only |

**Auth:** Username-password OAuth flow (`SF_CLIENT_ID`, `SF_CLIENT_SECRET`, `SF_USERNAME`, `SF_PASSWORD`, `SF_SECURITY_TOKEN`). Token is module-scoped and reused within a run.

### `scripts/pardot.mjs`

| Command | What it does | Called by the live routines? |
|---------|-------------|-------------------------------|
| `get-member-count --campaign-id` | `GET /api/v5/objects/campaigns/{id}` → returns `{ count }` | Yes — a6 sync watchdog |
| `create-campaign` | `POST https://pi.pardot.com/api/v5/objects/campaigns` with SF campaign ID | **No** — the SF admin links the Connected Campaign manually in Account Engagement per the a2 spec comment |

**Auth:** Reuses Salesforce OAuth token. Sends `Pardot-Business-Unit-Id` header on every request.

### `scripts/slack.mjs`

| Command | What it does |
|---------|-------------|
| `alert --message "..."` | `POST https://slack.com/api/chat.postMessage` to `SLACK_ALERT_CHANNEL` — health/escalation alerts |
| `send --channel "..." --message "..."` | Posts to an arbitrary channel (e.g. `#mops-team`) — used by a4 to post the brief |
| `dm [--user ID] --message "..."` | `conversations.open` then `chat.postMessage` to a DM — used by a2 to send Felipe the segmentation brief; defaults to `SLACK_FELIPE_USER_ID` if `--user` is omitted |

### `scripts/sheets.mjs`

| Command | What it does |
|---------|-------------|
| `log` | Appends one audit row to the Google Sheets audit tab: task ID, automation, decision, type, region, SF campaign ID, timestamp |
| `get-similar --limit N` | Reads the audit sheet, filters rows where Decision = "completed", returns the N most recent for self-improvement context |
| `check-calendar --date --type --segment` | Reads the `SendCalendar` tab; checks the Tuesday block, the 3-email/7-day segment limit, and 48h audience overlap → `{ conflicts: [], warnings: [] }` — called by a3 before creating the asset checklist |
| `log-send --date --type --segment --campaign` | Appends a row to `SendCalendar` once a send clears the conflict check — called by a3 |

**Auth:** Service account JWT (RS256) via Node's built-in `crypto.createSign` — no npm dependency. Exchanges the JWT for an OAuth2 access token at `oauth2.googleapis.com/token`, then calls Sheets API v4.

---

## 7. Self-Correcting Behavior

Unlike a fixed script, the Claude agent reasons about failures and adjusts.

| Error type | Self-correction behavior |
|---|---|
| SF ID reply doesn't match `[approvedName]` | Comments back on the mismatch, asks the admin to re-verify, stays `pending-sf-creation` |
| SF auth error | Script handles OAuth refresh automatically; agent retries once |
| Ambiguous intake classification | Re-reads full task description before assigning low confidence |
| Generic/weak name description | Re-reads the intake and retries the description segment before posting |
| Send-calendar conflict detected | Blocks checklist creation, comments with the specific conflict(s), waits for `calendar-cleared` |
| SLA breach risk (approval/SF-creation overdue) | Escalates immediately via Slack, bypassing the normal 24h timer |
| Asana subtask creation failure | Retries once; if fails again, notes it in summary and continues |
| Missing brief section | Checks all 6 sections before posting; adds any that are missing |
| Unrecoverable error | Sends Slack alert, adds Asana comment, marks task as `error` in state, moves to next task |

**Self-improvement:** Before classifying each campaign, the agent calls `scripts/sheets.mjs get-similar` to retrieve recent successful campaigns as context examples. Classification accuracy improves over time as more examples accumulate.

---

## 8. Environment Variables

| Variable | Used by | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | Cloud routine | Anthropic API key (for the routine's Claude session) |
| `ASANA_ACCESS_TOKEN` | `scripts/` (fallback) | Personal access token — MCP handles auth in cloud runs |
| `ASANA_WORKSPACE_GID` | Future use | Workspace GID for user lookups |
| `ASANA_INTAKE_PROJECT_GID` | Routine prompt | GID of the intake form project |
| `SF_INSTANCE_URL` | `scripts/salesforce.mjs` | `https://login.salesforce.com` or MyDomain URL |
| `SF_CLIENT_ID` | `scripts/salesforce.mjs` | Connected App client ID |
| `SF_CLIENT_SECRET` | `scripts/salesforce.mjs` | Connected App client secret |
| `SF_USERNAME` | `scripts/salesforce.mjs` | SF user email |
| `SF_PASSWORD` | `scripts/salesforce.mjs` | SF user password |
| `SF_SECURITY_TOKEN` | `scripts/salesforce.mjs` | SF user security token (appended to password) |
| `SF_CAMPAIGN_RECORD_TYPE_ID` | `scripts/salesforce.mjs` | 18-char Record Type ID for Campaign object |
| `PARDOT_BUSINESS_UNIT_ID` | `scripts/pardot.mjs` | 18-char Account Engagement BU ID (`0Uv…`) |
| `SLACK_BOT_TOKEN` | `scripts/slack.mjs` | Bot OAuth token (`xoxb-…`) |
| `SLACK_ALERT_CHANNEL` | `scripts/slack.mjs` | Channel ID for health alerts (`alert` command) |
| `SLACK_FELIPE_USER_ID` | `scripts/slack.mjs` | Default DM recipient (`dm` command) for a2's segmentation brief when `--user` isn't passed |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | `scripts/sheets.mjs` | Service account email (e.g. `mops-bot@project.iam.gserviceaccount.com`) |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | `scripts/sheets.mjs` | RSA private key PEM — copy `private_key` from service account JSON; replace literal `\n` with newlines |
| `GOOGLE_SHEETS_SPREADSHEET_ID` | `scripts/sheets.mjs` | Spreadsheet ID from the URL (between `/d/` and `/edit`) |
| `GOOGLE_SHEETS_AUDIT_SHEET` | `scripts/sheets.mjs` | Sheet tab name for the audit log (default: `AuditLog`) |
| `GOOGLE_SHEETS_CALENDAR_SHEET` | `scripts/sheets.mjs` | Sheet tab name for the send calendar (default: `SendCalendar`), used by `check-calendar`/`log-send` in a3 |

---

## 9. Error Handling

### Per-stage behavior

| Stage | Max retries | What triggers retry |
|-------|------------|---------------------|
| a1 completeness gate | 0 | Missing required field → `incomplete-requirements`, stop |
| a1 classification | 1 re-read | Ambiguous intake fields |
| a5 name description | 1 fix loop | Generic/weak self-generated description |
| a2 SF ID verification | 0 (comment + re-poll) | ID not found or name mismatch |
| a3 calendar check | 0 (blocks + comment) | Tuesday block / 3-email limit conflict |
| a3 subtask creation | 1 retry per item | API error |
| a4 brief posting | 0 | Verify sections before posting |
| Any unrecoverable | 0 | Slack + Asana comment + `error` state |

### Early-exit conditions

| Stop point | Condition | What's recorded |
|---|---|---|
| After a1 completeness gate | Required field(s) missing | Task → `incomplete-requirements` in state |
| After a1 classification | Confidence < 0.7 | Task → `flagged` in state |
| After a5 | Name pending human approval | Task → `pending-approval` in state |
| After a2 spec | Awaiting SF admin's Campaign ID | Task → `pending-sf-creation` in state |
| After a3 calendar check | Send-calendar conflict | State unchanged; blocked until `calendar-cleared` |
| Any stage | Unrecoverable error | Task → `error` in state |
| One-time seed | Task predates automation | Task → `pre-existing-skip` in state |
| Success | All stages complete | Task → `completed` in state |

---

## 10. Security Model

- **Secrets:** All credentials are environment variables, set locally in a gitignored `.env` (see §8 for the full list of keys). No real credentials in the repository.
- **Asana MCP:** Handles authentication automatically in cloud runs — no token code needed in the agent.
- **Script credentials:** Each `.mjs` script reads from `process.env` and throws a descriptive error if a required variable is missing.
- **Salesforce scope:** The automated routine only needs `api` scope + Campaign object **read**
  access (`find-campaign`, `query-campaigns`). Campaign/CampaignMemberStatus CRUD scope is only
  relevant to the legacy `create-campaign`/`add-member-statuses` commands, which a human may run
  locally but which the routine never calls — see §4.3.
- **No hardcoded values:** All org-specific values are in env vars or `// TODO(ground-truth):` placeholder constants.
- **State file:** `state/processed-tasks.json` is committed to the repo but contains only Asana task IDs — no credentials or sensitive data.

---

## 11. Deployment and Routines

### Live routines

| Routine | Schedule | URL |
|---------|----------|-----|
| MOps Intake Pipeline | Every hour (UTC) | https://claude.ai/code/routines/trig_01AoVLQMUh9X1K1aR7Phsd8a |
| MOps Sync Watchdog | Daily 09:00 UTC | https://claude.ai/code/routines/trig_013JndXKye2ntDeVyEXHYmh7 |

Both routines:
- Clone `https://github.com/flebdi/mops-ai-automation` on each run
- Have the Asana MCP connector attached (authenticated automatically)
- Run on `claude-sonnet-4-6`

### Updating routine behavior

To change what the agent does, edit `routines/intake-pipeline.md` or `routines/sync-watchdog.md` and push to GitHub. The next run will pick up the change automatically.

### First live run — recommended approach

1. Set `ASANA_INTAKE_PROJECT_GID` to a **test project** (not the live intake form)
2. Run the routine manually from the dashboard
3. Verify the run log: intake filter → completeness gate → classification → name generation → SF spec
4. Only after a successful test run, switch to the live intake project GID
5. **Run `routines/seed-backlog.md` once** against the live intake project GID before enabling the
   hourly schedule, so the existing backlog is marked `pre-existing-skip` and the pipeline only
   picks up new submissions. Do not run it again after this.
6. Monitor the first few live runs from the routines dashboard

### Wiring credentials into cloud routines

Cloud agents cannot read your local `.env`. To pass credentials:
1. Go to the routine URL above
2. Edit the routine prompt
3. Add credentials directly in the prompt text (e.g., `SF_CLIENT_ID=xxxx`)
4. The scripts will pick them up via `process.env` when the routine sets them

---

## 12. Ground-Truth TODO List

Values that must be confirmed from the live org before going live:

| # | Constant | File | Where to find it |
|---|----------|------|-----------------|
| 1 | `ASANA_INTAKE_PROJECT_GID` | `.env` | Asana intake project URL |
| 2 | `SF_CAMPAIGN_RECORD_TYPE_ID` | `.env` | SF Setup → Object Manager → Campaign → Record Types |
| 3 | `SF_FIELDS.BUDGET` (`BudgetedCost`) | `scripts/salesforce.mjs` | SF Setup → Object Manager → Campaign → Fields |
| 4 | `SF_PARDOT_CAMPAIGN_ID_FIELD` | `scripts/salesforce.mjs` | Confirm `ConnectedCampaignId` field name |
| 5 | `PARDOT_BUSINESS_UNIT_ID` | `.env` | Account Engagement → Settings → Business Unit Setup |
| 6 | Pardot member count field | `scripts/pardot.mjs` | Pardot API v5 docs — campaign object response |
| 7 | `GOOGLE_SHEETS_SPREADSHEET_ID` | `.env` | Google Sheets URL — the ID between `/d/` and `/edit` |
| 8 | `GOOGLE_SHEETS_AUDIT_SHEET` | `.env` | Sheet tab name for the audit log (e.g. `AuditLog`) |
| 9 | `SLACK_ALERT_CHANNEL` | `.env` | Slack channel ID (starts with `C`) |
| 10 | `SLACK_FELIPE_USER_ID` | `.env` | Felipe's Slack user ID (starts with `U`) — default `dm` recipient for the a2 segmentation brief |
| 11 | `GOOGLE_SHEETS_CALENDAR_SHEET` | `.env` | Sheet tab name for the send calendar (e.g. `SendCalendar`), plus create the tab with columns SendDate/Type/Segment/CampaignName |

---

## 13. Repository Structure

```
mops-ai-automation/
│
├── MOps.md                        # Project spec — source of truth
├── TECHNICAL.md                   # This document
├── README.md                      # Setup guide and overview
├── MANAGER_BRIEF.md               # Non-technical summary for stakeholders
├── package.json                   # Project metadata (no npm dependencies)
├── .gitignore                     # Excludes .env — see §8 for required keys
│
├── routines/
│   ├── intake-pipeline.md         # Agent instructions — hourly intake run
│   ├── sync-watchdog.md           # Agent instructions — daily watchdog run
│   └── seed-backlog.md            # Agent instructions — one-time backlog freeze (not scheduled)
│
├── scripts/
│   ├── salesforce.mjs             # SF OAuth + find-campaign/query-campaigns (read-only, live); create-campaign/add-member-statuses (legacy/manual-test-only)
│   ├── pardot.mjs                 # get-member-count (live, a6); create-campaign (manual, unused by routines)
│   ├── slack.mjs                  # alert, send, dm
│   └── sheets.mjs                 # audit log, similar-campaign lookup, send-calendar check + log
│
├── src/
│   └── config/                    # Business rules — Claude reads these on each run
│       ├── naming-rules.ts        # 6-type/35-subtype taxonomy, abbreviations, name builder
│       ├── routing.ts             # Region → owner, AM territories, segments, account types, SLA
│       ├── member-statuses.ts     # Per-type (+ Webinar override) SF member status lists
│       └── asset-checklists.ts    # Per-type (+ Webinar override) Asana subtask lists
│
└── state/
    ├── processed-tasks.json       # Idempotency: all task statuses (incl. incomplete-requirements, pre-existing-skip)
    └── watchdog-history.json      # Watchdog: daily findings for trend detection
```
