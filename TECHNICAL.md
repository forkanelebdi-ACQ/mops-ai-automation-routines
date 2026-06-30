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
- Classifies the intake using Claude AI
- Validates and corrects the campaign name (with human approval for corrections)
- Creates the Salesforce campaign with correct member-status scaffolding
- Creates all required Asana subtasks from the per-type asset checklist
- Drafts a one-page campaign brief and posts it to the Asana task
- Monitors daily that Pardot and Salesforce member counts remain in sync

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
│  │  Uses Asana MCP → classifies → validates name →      │  │
│  │  runs scripts/ → builds SF campaign → creates        │  │
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
  Asana MCP fetches new tasks from intake project
  For each unprocessed task:
        │
        ├─▶ a1: Classify
        │     Reads Asana task fields via MCP
        │     Classifies: type, region, quarter, owner, confidence
        │     If confidence < 0.7 → post Asana comment + Slack alert → skip
        │
        │   (only continues if confidence ≥ 0.7)
        │
        ├─▶ a5: Validate name  ← HARD GATE
        │     Checks against naming-rules.ts pattern
        │     If valid → proceed to a2
        │     If invalid → generate + self-validate correction → post to Asana
        │                → wait for human "approved" reply → then proceed
        │                → if no reply yet → skip task this run
        │
        │   (only continues after name approved)
        │
        ├─▶ a2: Build SF campaign
        │     node scripts/salesforce.mjs create-campaign
        │     node scripts/salesforce.mjs add-member-statuses
        │     node scripts/pardot.mjs create-campaign (non-fatal if fails)
        │
        ├─▶ a3: Asset checklist
        │     Reads asset-checklists.ts for campaign type
        │     Asana MCP creates one subtask per asset
        │     Posts summary comment to Asana
        │
        ├─▶ a4: Brief drafting
        │     Claude writes brief (Objective/Audience/Messaging/KPIs/Assets/Timeline)
        │     Posts as Asana comment
        │
        └─▶ Log + update state
              node scripts/sheets.mjs log
              Writes completed task ID to state/processed-tasks.json

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Independent routine:

sync-watchdog (daily 09:00 UTC)
  node scripts/salesforce.mjs query-campaigns
  For each: node scripts/pardot.mjs get-member-count
  Divergence → node scripts/slack.mjs alert
  Orphans    → node scripts/slack.mjs alert
  Monday     → weekly health report via Slack
```

---

## 4. Pipeline Stage Reference

### 4.1 a1 — Intake Triage

**What it does:**
Reads the Asana intake task fields using the Asana MCP and classifies the campaign.

**Classification fields:**
- `type`: one of `Event`, `Webinar`, `Email`, `Paid`, `Content`
- `region`: one of `AMER`, `EMEA`, `APJ`, `LATAM`
- `quarter`: `Q1`–`Q4` derived from go-live date
- `owner`: from `src/config/routing.ts` based on region
- `confidence`: 0.0–1.0

**Self-correction:** If any field is ambiguous, Claude re-reads the full task description before assigning a low confidence score.

**If confidence < 0.7:**
- Posts Asana comment flagging the unclear fields and tagging the regional owner
- Sends Slack alert
- Records task as `flagged` in state
- Does NOT continue to a5

---

### 4.2 a5 — Naming Enforcer (Gate)

**Naming convention:**
```
[Year]_[Region]_[Type]_[CampaignName]_[Quarter]
Example: 2026_EMEA_Webinar_DrupalSecurity_Q3
```

**Decision tree:**
```
validateCampaignName(intake name)
    │
    ├─ valid → proceed to a2
    │
    └─ invalid
           │
           ├─ generate corrected name from classification fields
           ├─ self-validate the correction before posting
           │       ├─ valid → post correction to Asana for approval
           │       └─ still invalid → fix and re-validate
           │
           ├─ post Asana comment: issues + suggestion + "reply 'approved'"
           └─ wait for human reply on next run
                   ├─ "approved" found → proceed to a2
                   └─ no reply after 24h → Slack escalation alert
```

**Hard gate:** a2 never runs unless a5 has explicitly approved a name. This is enforced in the routine prompt instructions.

---

### 4.3 a2 — Salesforce Campaign Build

Only reached after a5 approves.

**Step 1 — Create SF Campaign:**
```bash
node scripts/salesforce.mjs create-campaign \
  --name "[approvedName]" --type "[type]" --region "[region]" \
  --go-live "[date]" --budget "[budget]" --owner "[owner]"
```

**Step 2 — Add Member Statuses:**
```bash
node scripts/salesforce.mjs add-member-statuses \
  --campaign-id "[sfCampaignId]" --type "[type]"
```

Member statuses by type (from `src/config/member-statuses.ts`):

| Type | Statuses |
|------|---------|
| Event | Registered, Attended, No Show, Walk-in, Booth Visit |
| Webinar | Registered, Attended, No Show, On-Demand View |
| Email | Sent, Opened, Clicked, Bounced, Unsubscribed |
| Paid | Impression, Clicked, Form Fill, Converted |
| Content | Downloaded, Viewed, Engaged, Converted |

**Step 3 — Pardot Connected Campaign (non-fatal):**
```bash
node scripts/pardot.mjs create-campaign \
  --sf-campaign-id "[sfCampaignId]" --name "[approvedName]"
```
If Pardot fails, the SF campaign is kept. The error is logged and execution continues.

---

### 4.4 a3 — Asset Checklist

No AI involved — purely config-driven. Reads `src/config/asset-checklists.ts` for the campaign type, then uses the Asana MCP to create one subtask per asset item under the intake task.

**Asset counts by type:**

| Type | Asset items |
|------|------------|
| Event | 12 |
| Webinar | 10 |
| Email | 6 |
| Paid | 5 |
| Content | 5 |

Posts a summary comment to the Asana task listing everything created.

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

Posts the brief as an Asana comment labeled as auto-generated, under 400 words.

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

## 5. Configuration Modules

All rules live in `src/config/`. Claude reads these on each run.

### `src/config/naming-rules.ts`

```typescript
VALID_REGIONS:  ["AMER", "EMEA", "APJ", "LATAM"]
VALID_TYPES:    ["Event", "Webinar", "Email", "Paid", "Content"]
NAMING_PATTERN: /^(\d{4})_(AMER|EMEA|APJ|LATAM)_(Event|...)_([A-Z][A-Za-z0-9]+)_(Q[1-4])$/

validateCampaignName(name) → { valid, issues, parsed? }
buildCampaignName(year, region, type, rawName, quarter) → string
quarterFromDate(date) → "Q1" | "Q2" | "Q3" | "Q4"
```

### `src/config/routing.ts`

```typescript
REGION_OWNERS:    { AMER: "Harish", EMEA: "Aayushi", APJ: "Aayushi", LATAM: "Felipe" }
ESCALATION_HOURS: 24
CONFIDENCE_FLOOR: 0.7
```

### `src/config/member-statuses.ts`

```typescript
MEMBER_STATUSES:   Record<CampaignType, string[]>  // statuses to create on SF campaign
RESPONDED_STATUSES: Record<CampaignType, string[]> // which set HasResponded: true
```

### `src/config/asset-checklists.ts`

```typescript
ASSET_CHECKLISTS: Record<CampaignType, string[]>   // asset names → Asana subtask names
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

| Command | What it does |
|---------|-------------|
| `create-campaign` | OAuth token → `POST /sobjects/Campaign` → returns `{ sfCampaignId }` |
| `add-member-statuses` | One `POST /sobjects/CampaignMemberStatus` per status for the campaign type |
| `query-campaigns` | SOQL query for active campaigns with a Pardot link → returns array |

**Auth:** Username-password OAuth flow (`SF_CLIENT_ID`, `SF_CLIENT_SECRET`, `SF_USERNAME`, `SF_PASSWORD`, `SF_SECURITY_TOKEN`). Token is module-scoped and reused within a run.

### `scripts/pardot.mjs`

| Command | What it does |
|---------|-------------|
| `create-campaign` | `POST https://pi.pardot.com/api/v5/objects/campaigns` with SF campaign ID |
| `get-member-count` | `GET /api/v5/objects/campaigns/{id}` → returns `{ count }` |

**Auth:** Reuses Salesforce OAuth token. Sends `Pardot-Business-Unit-Id` header on every request.

### `scripts/slack.mjs`

| Command | What it does |
|---------|-------------|
| `alert --message "..."` | `POST https://slack.com/api/chat.postMessage` to `SLACK_ALERT_CHANNEL` |

### `scripts/sheets.mjs`

| Command | What it does |
|---------|-------------|
| `log` | Appends one audit row to the Google Sheets audit tab: task ID, automation, decision, type, region, SF campaign ID, timestamp |
| `get-similar --limit N` | Reads the audit sheet, filters rows where Decision = "completed", returns the N most recent for self-improvement context |

**Auth:** Service account JWT (RS256) via Node's built-in `crypto.createSign` — no npm dependency. Exchanges the JWT for an OAuth2 access token at `oauth2.googleapis.com/token`, then calls Sheets API v4.

---

## 7. Self-Correcting Behavior

Unlike a fixed script, the Claude agent reasons about failures and adjusts.

| Error type | Self-correction behavior |
|---|---|
| SF field validation error | Reads the error message, identifies the bad field, adjusts value, retries once |
| SF auth error | Script handles OAuth refresh automatically; agent retries once |
| Ambiguous intake classification | Re-reads full task description before assigning low confidence |
| Invalid name suggestion | Validates its own suggested name before posting — fixes it if still invalid |
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
| `SLACK_ALERT_CHANNEL` | `scripts/slack.mjs` | Channel ID for health alerts |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | `scripts/sheets.mjs` | Service account email (e.g. `mops-bot@project.iam.gserviceaccount.com`) |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | `scripts/sheets.mjs` | RSA private key PEM — copy `private_key` from service account JSON; replace literal `\n` with newlines |
| `GOOGLE_SHEETS_SPREADSHEET_ID` | `scripts/sheets.mjs` | Spreadsheet ID from the URL (between `/d/` and `/edit`) |
| `GOOGLE_SHEETS_AUDIT_SHEET` | `scripts/sheets.mjs` | Sheet tab name for the audit log (default: `AuditLog`) |

---

## 9. Error Handling

### Per-stage behavior

| Stage | Max retries | What triggers retry |
|-------|------------|---------------------|
| a1 classification | 1 re-read | Ambiguous intake fields |
| a5 name correction | 1 fix loop | Invalid self-generated name |
| a2 SF create | 1 retry | Field error or auth error |
| a2 Pardot create | 0 (non-fatal) | Any error — logged and skipped |
| a3 subtask creation | 1 retry per item | API error |
| a4 brief posting | 0 | Verify sections before posting |
| Any unrecoverable | 0 | Slack + Asana comment + `error` state |

### Early-exit conditions

| Stop point | Condition | What's recorded |
|---|---|---|
| After a1 | Confidence < 0.7 | Task → `flagged` in state |
| After a5 | Name pending human approval | Task → `pending-approval` in state |
| After a5 | Name rejected | Task → `flagged` in state |
| Any stage | Unrecoverable error | Task → `error` in state |
| Success | All stages complete | Task → `completed` in state |

---

## 10. Security Model

- **Secrets:** All credentials are environment variables. `.env.example` has empty keys only. No real credentials in the repository.
- **Asana MCP:** Handles authentication automatically in cloud runs — no token code needed in the agent.
- **Script credentials:** Each `.mjs` script reads from `process.env` and throws a descriptive error if a required variable is missing.
- **Salesforce scope:** Minimum required — `api` scope + Campaign object CRUD + CampaignMemberStatus CRUD.
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
3. Verify the run log: classification → name validation → SF campaign creation
4. Only after a successful test run, switch to the live intake project GID
5. Monitor the first few live runs from the routines dashboard

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
├── .env.example                   # All required env vars (empty values)
├── .gitignore
│
├── routines/
│   ├── intake-pipeline.md         # Agent instructions — hourly intake run
│   └── sync-watchdog.md           # Agent instructions — daily watchdog run
│
├── scripts/
│   ├── salesforce.mjs             # SF OAuth + campaign CRUD
│   ├── pardot.mjs                 # Pardot API v5 operations
│   ├── slack.mjs                  # Slack alert sender
│   └── sheets.mjs                 # Google Sheets audit log + similar campaign lookup
│
├── src/
│   └── config/                    # Business rules — Claude reads these on each run
│       ├── naming-rules.ts        # Naming convention regex, validator, builder
│       ├── routing.ts             # Region → owner, confidence floor
│       ├── member-statuses.ts     # Per-type SF member status lists
│       └── asset-checklists.ts    # Per-type Asana subtask lists
│
└── state/
    ├── processed-tasks.json       # Idempotency: completed/flagged/error task IDs
    └── watchdog-history.json      # Watchdog: daily findings for trend detection
```
