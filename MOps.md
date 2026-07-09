# MOps AI Automation — Project Memory (`MOps.md`)

> **Read this first.** This is the single source of truth for the MOps AI Automation project.
> It captures what we're building, why, the rules it must follow, and the conventions for
> building it with Claude Code routines. Place it at the repo root so Claude Code reads it on every run.
> Keep it current — when a decision changes, change it here.
>
> **Naming:** "SF" = Salesforce. Project-management tool = **Asana**.
> **Stack note:** The runtime is **Claude Code routines** (scheduled agents). Scripts in `scripts/`
> are plain Node.js `.mjs` files. No Trigger.dev dependency.

---

## 1. What this project is

The MOps team is currently the **manual integration layer** between four systems that don't
talk to each other: the Asana intake form, Asana tasks, Salesforce, and Pardot. A human reads
each campaign request and re-keys it into Asana and Salesforce by hand. That is slow, drifts
from naming convention, and silently breaks Pardot–SF sync.

**Goal:** from a *single* Asana form submission, automatically check the intake is complete, parse
it, validate the name, build the complete Salesforce campaign spec (member-status scaffolding, AM
territories, targeting context) for the SF admin to create, generate the asset checklist and
Asana subtasks, draft a campaign brief, and monitor sync health — turning a days-long manual
process into a minutes-long, mostly-automated one, with a human only on the uncertain cases and on
the Salesforce write itself.

The two slide decks in this repo are the canonical overview:
- `MOps_AI-Powered_Campaign_Workflow.pdf` — the original intern project plan (problem, the six automations, 8-week plan).
- `MOps_AI_Automation_Walkthrough.pdf` — the leadership walkthrough (problem → outcome → pipeline → stack → timeline → handoff → impact).

---

## 2. The one architectural rule that cannot change

The per-ticket pipeline runs in this order:

```
a1 (triage)  →  a5 (naming GATE)  →  a2 (SF build)  →  a3 (assets)  →  a4 (brief)
```

- **`a5` runs before `a2`.** If the campaign name fails validation, `a2` must NOT run.
  The naming gate is the single control that authorizes Salesforce record creation.
  Violating this order pollutes Salesforce with badly-named records and breaks reporting.
- **`a6` (sync watchdog) is NOT in the per-ticket flow.** It runs on a schedule (cron).
- **Two filters run before `a1` even scores confidence**: an intake-form filter (only tasks with a
  non-empty "What are you Requesting?" field, no parent task, and not marked complete are
  processed — everything else is skipped silently, added specifically to stop the pipeline firing
  on report requests, list uploads, and other non-intake tasks in the same project) and a
  completeness gate (checks the 8 required intake fields; if anything is missing, the task is
  marked `incomplete-requirements` and skipped entirely, without ever reaching classification).

---

## 3. The six automations

| # | Name | What it does | Key systems |
|---|------|--------------|-------------|
| a1 | Intake triage | Filters to genuine intake tasks, runs a completeness gate on 8 required fields (stops and marks `incomplete-requirements` if anything is missing), then classifies type & subtype & region, extracts fields (goal/audience/key message/budget, account-type & business-segment targets), routes to the regional owner, scores confidence, confirms to requestor | Asana, Claude |
| a2 | SF campaign spec (read-only) | **Claude Code has read-only SF access.** Checks SF for an existing campaign by name; if absent, resolves AM territories (`getAmTerritoriesForCampaign`), posts the complete spec (name, type, dates, budget, member-status list, account-type/business-segment targeting, AM territories) as an Asana comment for the SF admin to create manually, and DMs Felipe (`SEGMENTATION_OWNER`) a segmentation brief via Slack. Sets state to `pending-sf-creation`. On the next run, scans comments for an 18-char SF Campaign ID (starts with `701`), verifies it via a read-only SF lookup, then unblocks a3/a4. Escalates via Slack after 24h with no reply, or immediately if business days to go-live are within the type's `SLA_ESCALATION_DAYS` threshold. Admin is also asked to link the Pardot connected campaign in Account Engagement. | Salesforce (read), Asana, Slack |
| a3 | Asset checklist + subtasks | Runs a send-calendar conflict check first (Tuesday block for Welcome Nurture, 3-email/7-day segment limit, 48h audience-overlap warning) and blocks on conflicts; once clear, generates the per-type (or per-subtype, e.g. Webinar) asset checklist and creates every Asana subtask | Asana, Claude, Google Sheets |
| a4 | Brief drafting | Turns intake into a one-page brief (objective, audience, messaging, KPIs, assets, timeline); posts it to Asana (system of record) **and** to Slack `#mops-team` | Claude, Asana, Slack |
| a5 | Name generator **(gate)** | Generates the canonical campaign name from intake fields (`type_subtype_region_description_year_quarter`, all lowercase), posts it to Asana for owner confirmation, and gates `a2` until approved | Claude |
| a6 | Sync watchdog | Daily scan comparing Pardot vs SF member counts; Slack alert on divergence; detects orphaned Pardot assets; weekly health report; escalates persistent (3+ consecutive day) divergence | Pardot, Salesforce, Slack |

> **One-time setup routine — not one of the six:** `routines/seed-backlog.md` runs once, before the
> pipeline goes live, to freeze the pre-existing Asana backlog. It marks every already-open intake
> task as `pre-existing-skip` in state so the hourly pipeline only processes tasks created after
> that point. It is not scheduled and must not be run a second time.

---

## 4. Tech stack (decided)

| Layer | Choice | Notes |
|-------|--------|-------|
| Language | **TypeScript / Node.js ESM** | Scripts in `scripts/*.mjs`. Config in `src/config/*.ts`. |
| Build | **Claude Code** | Writes every routine/script. Reads this file for context. |
| Run / host | **Claude Code routines** | Scheduled agents (hourly minimum). No separate run host needed. See §7. |
| Reasoning | **Claude (native)** | The routine *is* Claude — no SDK wrapper needed for reasoning. Claude calls Bash scripts for external systems. |
| Asana | **Asana MCP** | All Asana reads/writes go through the Asana MCP tool (not a custom lib). |
| Connect | Salesforce, Pardot, Slack, Google Sheets | Plain Node `.mjs` scripts in `scripts/` called via Bash. |
| Config / audit | **Google Sheets** | Editable rules + per-decision audit log. The team edits a sheet, not code. |
| State | **`state/processed-tasks.json`** | Persistent JSON array tracking each task's pipeline status across runs. |
| Testing / UI gaps | **Playwright** | End-to-end tests (submit the real Asana form, verify the pipeline) and the rare UI-only action where no API exists. Used sparingly — APIs first. |

---

## 5. Team & the non-negotiable constraint: maintainability

The system will be owned long-term by **non-technical regional MOps owners**:
- **Harish — AMER**
- **Aayushi — EMEA / APJ**
- **Felipe — LATAM**

They cannot read a stack trace, redeploy a container, or fix code. The build must therefore be
maintainable *without* engineering:

1. **Editable rules live in Google Sheets**, never hardcoded — naming rules, the region→owner routing
   table, member statuses, asset checklists, message templates. Changing a rule = editing a row.
2. **Visibility via Google Sheets audit log + Slack alerts** — every run logs its decisions to Google Sheets
   keyed by Asana task ID; failures fire a Slack alert. Owners can see what happened without code.
3. **Human-in-the-loop** on low-confidence classifications (flagged in Asana + Slack) and naming
   corrections (require Asana comment approval before Salesforce is touched).
4. **A named technical escalation contact** in the handoff playbook for breakages no rule edit can fix.

> Honest caveat: this is still a code project. Keep anything that changes often in Google Sheets; keep the
> routine logic stable and rarely-touched.

---

## 6. Domain ground truth (the rules the automations enforce)

> These values are mirrored in Google Sheets (and/or `src/config/`) so they can be edited without code.
> The lists below are the current truth; confirm against the live org during the Week 1–2 ramp.

### 6.1 Naming convention
```
type_subtype_region_description_year_quarter
e.g.  evt_ws_all_dam workshop boston_2026_q3
```
- **Type** — one of 6 top-level types in `src/config/naming-rules.ts` → `TAXONOMY`: `Demand Gen`,
  `Email`, `Event`, `Operational`, `Social`, `Web`. Mapped from the intake's "What are you
  Requesting?" field.
- **Subtype** — one of 35 subtypes total across the 6 types, e.g. Event → Roundtable / Workshop /
  Tradeshow / Acquia Engage / User Group / Corporate Event / Webinar; Email → Newsletter /
  Transactional / Promotion / Follow-Up / Nurture / Retargeting; Demand Gen → Direct Mail /
  Display Ad / Search / External List / ABM Advertisement / Content Syndication / Paid Search /
  Gifting / Agent (Conversational Email); Social → Organic Social / Paid Social; Web → Organic /
  Contact Sales / Demo / Web Form / Resources / Clickable Demos / AI Agents / Chatbot /
  Corporate/Brand/Sponsorship / AcquiaTV; Operational → Operational.
- **Region** — one of `amer`, `emea`, `apj`, `latam`, or `all` for global campaigns (lowercase in the name).
- **Description** — **Claude generates this** from the intake's `key_message`, `goal`, and
  `audience`. 2–5 lowercase words, space-separated within the segment. Specific enough that any
  team member instantly knows what the campaign is about.
- **Year** — 4 digits derived from `go_live_date`.
- **Quarter** — lowercase `q1`–`q4` derived from `go_live_date`.

Everything in the assembled name is lowercase; underscores separate the six segments. `type` and
`subtype` use the abbreviations in `TAXONOMY` (e.g. `evt`, `wbr`, `dg`, `em`, `soc`, `web`, `ops`).

**How naming works:** The requestor never types a name in this format. Claude derives all six
segments from the intake form fields, assembles the canonical name, and posts it to Asana for the
regional owner to confirm. The owner approves or provides a revised description and Claude rebuilds
just that segment. The gate blocks `a2` until confirmed.

> This replaced the original PascalCase `[Region]_[Type]_[Topic]_[Year]_[Quarter]` /
> `[Year]_[Region]_[Type]_[CampaignName]_[Quarter]` convention (types: Event, Webinar, Email, Paid,
> Content) per the 2026 revised taxonomy.

### 6.2 Region → owner routing
| Region | Owner |
|--------|-------|
| AMER | Harish |
| EMEA | Aayushi |
| APJ | Aayushi |
| LATAM | Felipe |

Escalate if the owner does not respond within **24 hours**.

**SLA escalation override:** regardless of the 24-hour timer, if the business days remaining
until `go_live_date` are at or below the type's threshold in `SLA_ESCALATION_DAYS`
(`src/config/routing.ts`), escalate immediately — applies to both the name-approval (a5) and
SF-creation (a2) follow-ups:

| Type | Threshold (business days) |
|------|---------------------------|
| Event (incl. Webinar subtype) | 7 |
| Email | 5 |
| Demand Gen | 5 |
| Web | 4 |
| Social | 4 |
| Operational | 3 |

> TODO(ground-truth): Operational/Social thresholds are carried over from their closest retired
> equivalent and need confirming against the live SLA doc.

**Business segment targets** (`BUSINESS_SEGMENTS`): `Enterprise`, `Mid-Market`, `Growth`,
`Public Sector` (Government - Federal / Government - State/Local industries only), `All Segments`.

**Account type targets** (`ACCOUNT_TYPE_TARGETS`): `Prospect`, `Customer`, `Partner`,
`Former Customer`, `All`.

**AM territories:** `a2` resolves the AM territory list for a campaign via
`getAmTerritoriesForCampaign(region, businessSegment, industry?)` (`src/config/routing.ts`) — it
intersects `SEGMENT_AM_TERRITORY_GROUPS[segment]` with `REGION_AM_TERRITORIES[region]`, falling
back to the full region list when the segment is `All Segments` or the intersection is empty. This
list is included in the SF spec comment so AMs can flag relevant accounts for member inclusion.

**Segmentation owner:** `SEGMENTATION_OWNER` is **Felipe** — he receives a Slack DM
(`scripts/slack.mjs dm`) with a segmentation/targeting brief every time `a2` posts a new SF spec,
so he can build the target list and confirm audience filters in Pardot before go-live.

### 6.3 Member statuses by campaign type (read via `getMemberStatuses`, listed in `a2`'s spec comment)
- **Demand Gen:** Impression, Clicked, Form Fill, Converted
- **Email:** Sent, Opened, Clicked, Bounced, Unsubscribed
- **Event:** Registered, Attended, No Show, Walk-in, Booth Visit
  - **Webinar (subtype override):** Registered, Attended, No Show, On-Demand View
- **Operational:** Sent, Delivered, Failed
- **Social:** Impression, Clicked, Engaged, Converted
- **Web:** Viewed, Downloaded, Engaged, Converted

`getMemberStatuses(type, subtype)` in `src/config/member-statuses.ts` checks for a subtype
override (currently only Webinar) before falling back to the type default. These are listed in
the SF spec comment for the admin to apply — `a2` does not write them to Salesforce directly.

### 6.4 Asset checklists by type (turned into Asana subtasks by `a3`, via `getAssetChecklist`)
- **Demand Gen:** ad copy variants (headline/body/CTA) · landing page + form aligned · UTMs + tracking pixels · content asset to DAM + linked · brief shared with demand-gen lead
- **Email:** HTML build + plain text · list-pull segmentation brief · Pardot email record + send config · UTM params · A/B subject variants
- **Event:** landing page + form · email invite ×3 · reminder ×2 · follow-up ×2 (attended / no-show) · SF campaign + child campaigns · speaker brief · run-of-show
  - **Webinar (subtype override):** landing page + form · email invite ×3 · reminder ×2 · follow-up ×2 · on-demand recording asset · SF campaign
- **Operational:** send config + trigger logic documented · QA pass on trigger conditions · suppression/exclusion list confirmed
- **Social:** post copy variants (2–3) · creative asset sized per platform · UTM params · posting schedule confirmed · brief shared with social lead
- **Web:** page copy/content brief · creative asset to DAM + linked · UTMs + tracking pixels · page live + QA'd · brief shared with web lead

`getAssetChecklist(type, subtype)` in `src/config/asset-checklists.ts` checks for a subtype
override (currently only Webinar) before falling back to the type default.

### 6.5 Triage guardrails (`a1`)
- **Intake-form filter** (runs before anything else, on every fetched task): only process a task
  if it has a non-empty "What are you Requesting?" custom field, has no parent task, and is not
  marked complete. Anything else is skipped silently — no comment, no state entry.
- **Completeness gate** (runs before classification): checks 8 required intake fields (Subject
  Line/Preheader, Banners/creative, Content Copy, URLs, Audience Segmentation, Dates, Send Times,
  Exclusion Lists — some conditional by type). If anything is missing, comment with the missing
  fields, set Asana status to `incomplete requirements`, record `incomplete-requirements` in
  state, and stop — classification never runs.
- Confidence floor = **`CONFIDENCE_FLOOR` = 0.7** (`src/config/routing.ts`) → below it, route to human review.
- Low-confidence or missing/contradictory fields → human review, do not proceed.
- Requestor can override the classification via an Asana comment.
- **Every AI decision is logged per ticket** (audit trail).

### 6.6 Brief inputs/outputs (`a4`)
- In: campaign name, type, owner, audience, region, goal (MQLs / pipeline / awareness / retention), go-live date, budget range, key message, linked/parent programs.
- Out: one-page brief (objective, audience, messaging, KPIs), recommended asset list, timeline with milestones; posted to the Asana task (system of record) **and** to Slack `#mops-team`.

### 6.7 Send calendar rules (checked by `a3` via `scripts/sheets.mjs check-calendar`)
Enforced against the `SendCalendar` Google Sheet before the asset checklist is created:
- **Tuesday block** — Tuesdays are reserved for Welcome Nurture sends; any other type proposed on
  a Tuesday is a conflict.
- **3-email/7-day limit** — no more than 3 marketing email sends to the same business segment in
  any 7-day window.
- **48-hour audience-overlap warning** — any other campaign targeting the same segment within 48
  hours is flagged as a non-blocking warning.

Conflicts block the checklist (Asana comment + resolution required, reply `calendar-cleared`).
Warnings are noted but do not block. A cleared send is registered via `scripts/sheets.mjs
log-send` so future campaigns see it.

---

## 7. Claude Code routine conventions (how to write routines)

> The full intake pipeline routine is in `routines/intake-pipeline.md`. The rules below are mandatory.

### How routines work
- A **routine** is a Markdown file in `routines/` that Claude Code executes as a scheduled agent.
- The routine prompt describes every step Claude must take; Claude uses its native reasoning plus
  **Asana MCP** (for all Asana operations) and **Bash** (to call `scripts/*.mjs` for SF, Pardot,
  Slack, Google Sheets) to carry out the steps.
- Minimum schedule interval is **1 hour**. Intake pipeline runs `0 * * * *`.

### State persistence
- Idempotency is handled via **`state/processed-tasks.json`** — a JSON array of
  `{ id, status, approvedName?, sfCampaignId? }` objects. Claude reads this at the start of
  every run and skips tasks already marked `completed`.
- Statuses: `incomplete-requirements` | `flagged` | `pending-approval` | `approval-received` |
  `pending-sf-creation` | `completed` | `error` | `pre-existing-skip`.
  - `incomplete-requirements` — the completeness gate in a1 found missing required fields; classification never ran.
  - `pending-sf-creation` — spec posted to Asana, waiting for the SF admin to create the campaign and reply with the Campaign ID.
  - `pre-existing-skip` — set once by the one-time `routines/seed-backlog.md` run for every task that predates the automation; STEP 1 of the intake pipeline skips these forever.

### Asana status mirroring
Every state write also sets the Asana task's status field, so team visibility works from Asana
alone — no dependency on the JSON state file or Slack history (Asana is the system of record):

| Internal state              | Asana status field value  |
|-----------------------------|---------------------------|
| `incomplete-requirements`   | `incomplete requirements` |
| `flagged`                   | `needs information`       |
| `pending-approval`          | `approval`                |
| `approval-received`         | `approval`                |
| `pending-sf-creation`       | `in a sprint`             |
| `completed`                 | `completed`               |
| `error`                     | `needs information`       |

### Human-in-the-loop
- **Naming corrections**: Claude posts an Asana comment with the suggested fix, sets status to
  `pending-approval`, and polls for "approved" in comments on the next run(s).
- **24-hour escalation**: if no approval after 24 h, a Slack alert fires via
  `node scripts/slack.mjs alert`.
- **SLA escalation override**: regardless of the 24h timer, if business days remaining until
  go-live are at or below `SLA_ESCALATION_DAYS[type]` (`src/config/routing.ts`), escalate
  immediately — applies to both name-approval (a5) and SF-creation (a2) follow-ups.

### Calling external systems
All calls to Salesforce, Pardot, Slack, and Google Sheets go through scripts:
```bash
# Salesforce — READ-ONLY in the automated flow (Claude Code never creates/mutates SF records)
node scripts/salesforce.mjs find-campaign --name "..."       # look up by exact name (a2, live)
node scripts/salesforce.mjs find-campaign --id "701..."      # verify an ID posted by the admin (a2, live)
node scripts/salesforce.mjs query-campaigns                  # used by sync watchdog (a6, live)
# create-campaign and add-member-statuses exist in the script but are legacy/manual-test-only —
# not called by the automated routine; useful for a human running the script locally (see README).

# Pardot — read-only in the automated flow
node scripts/pardot.mjs get-member-count --campaign-id "..." # used by sync watchdog (a6, live)
# create-campaign exists in the script but is not called by any routine — the SF admin links the
# connected campaign manually in Account Engagement per the a2 spec comment.

# Slack
node scripts/slack.mjs alert --message "..."                          # health/escalation alerts
node scripts/slack.mjs send --channel "#mops-team" --message "..."    # a4 brief
node scripts/slack.mjs dm --message "..."                             # a2 segmentation brief → Felipe

# Google Sheets
node scripts/sheets.mjs log --task-id "..." --automation "..." --decision "..."
node scripts/sheets.mjs get-similar --limit 3
node scripts/sheets.mjs check-calendar --date "..." --type "..." --segment "..."             # a3, before checklist
node scripts/sheets.mjs log-send --date "..." --type "..." --segment "..." --campaign "..."  # a3, after clear
```
Scripts output JSON on stdout. Claude reads the JSON and handles errors.

> **Pardot:** The Pardot connected campaign is created by the SF admin as part of the manual
> creation step. The spec comment in a2 instructs the admin to link it in Account Engagement.

### Error handling pattern
- On a recoverable error: adjust the offending field and retry once.
- On a second failure: post an Asana comment with the error, fire a Slack alert, mark the task
  `error` in state, and **continue to the next task** — one failure must never stop the whole run.

### Watchdog (a6) — separate routine
`routines/sync-watchdog.md` runs daily at 09:00 UTC (Mondays also trigger the weekly report inside
the same run):
1. Call `node scripts/salesforce.mjs query-campaigns` and, for each result, `node scripts/pardot.mjs get-member-count`
2. Compare member counts; any non-zero delta is a finding, a missing `pardotCampaignId` is an orphan
3. `node scripts/slack.mjs alert` per finding and per orphan batch; escalate if the same campaign
   diverges 3+ consecutive days (`state/watchdog-history.json`)
4. Monday only: build and post a weekly sync-health report

### Backlog seed (one-time) — separate routine
`routines/seed-backlog.md` is **not scheduled**. It runs once, manually, before the intake
pipeline goes live: it fetches every incomplete task in the intake project, and for any task not
already in state, adds `{ id, status: "pre-existing-skip" }`. From then on, STEP 1 of the intake
pipeline silently skips any task in that status forever. Do not run it a second time.

---

## 8. Repository structure

```
mops-ai-automation/
├── MOps.md                        # this file — project memory
├── package.json                   # Node.js deps (for scripts only)
├── .env                           # Local credentials (gitignored; no .env.example — see §8 env vars)
├── routines/
│   ├── intake-pipeline.md         # Claude Code routine: a1 → a5 gate → a2 → a3 → a4 (hourly)
│   ├── sync-watchdog.md           # Claude Code routine: a6 Pardot/SF sync check (daily + weekly)
│   └── seed-backlog.md            # one-time routine: freezes the pre-existing Asana backlog
├── scripts/                       # Node.js ESM scripts called via Bash from routines
│   ├── salesforce.mjs             # find-campaign, query-campaigns — READ-ONLY, used live; create-campaign/add-member-statuses are legacy/manual-test-only
│   ├── pardot.mjs                 # get-member-count — used live by a6; create-campaign is manual/unused by routines
│   ├── slack.mjs                  # alert, send, dm
│   └── sheets.mjs                 # log, get-similar, check-calendar, log-send
├── state/
│   └── processed-tasks.json       # idempotency state — array of { id, status, ... }
├── src/
│   └── config/                    # editable rules (mirrored in Google Sheets)
│       ├── naming-rules.ts
│       ├── routing.ts
│       ├── member-statuses.ts
│       └── asset-checklists.ts
└── e2e/
    └── intake.spec.ts             # Playwright: submit the form, assert the pipeline ran
```

---

## 9. Build plan — fast-track sprint (~2 weeks)

> **Goal: ship as fast as possible.** With Claude Code, the coding collapses to days. The real
> pace-setters are **access/credentials** and **ground truth** (§12), not typing — so secure those
> on Day 0 in parallel, or the rest of the plan stalls. Day numbers are working days.

| Day(s) | Milestone | Deliverable |
|--------|-----------|-------------|
| **0 (parallel, blocking)** | **Access + ground truth** | Asana MCP token, Salesforce Connected App, Pardot OAuth, Slack token. Document live SF campaign fields + status sets and the real Asana form fields into Google Sheets/`src/config/` (fills §6 + §12). *This is the true bottleneck — start it immediately.* |
| **1** | **Scaffold + scripts** | Repo structure, `src/config/` files, stub scripts in `scripts/` (salesforce.mjs, pardot.mjs, slack.mjs, sheets.mjs), `state/processed-tasks.json` init. |
| **2–3** | **Front gate** | `routines/intake-pipeline.md` with a1 triage + a5 naming gate wired up. Test with a mock Asana task. |
| **3–4** | **SF spec + polling** | `scripts/salesforce.mjs` read-only commands (find-campaign by name/ID). Wire a2 spec-posting and ID-polling into routine as STEP 3. No SF write access — campaign creation is delegated to the SF admin via Asana comment. |
| **4–5** | **Generate** | a3 asset checklist via Asana MCP subtask creation + a4 brief posting as Asana comment. |
| **5** | **Watchdog** | `routines/sync-watchdog.md` + `scripts/pardot.mjs get-member-count`. Schedule daily + weekly. |
| **6** | **QA** | Playwright e2e (submit the real form → assert the pipeline ran); fix bugs; state idempotency check (run twice, verify no duplicates). |
| **7** | **UAT + go-live** | UAT with one regional owner; handoff playbook; go live. The human-in-the-loop gate is the Asana comment approval flow built into the routine. |

Build order: `src/config/` → `scripts/salesforce.mjs` + `scripts/slack.mjs` → `routines/intake-pipeline.md` (a1+a5) → a2 → a3/a4 → `scripts/pardot.mjs` + `routines/sync-watchdog.md`.

**To go even faster / de-risk:** ship a **thin slice first** — `a1 → a5 → a2` only (form in →
correctly-named SF campaign with statuses out). That alone kills the two biggest pain points
(manual intake, no naming enforcement) and can be live in **~3–4 days**. Add `a3`/`a4`/`a6` as
fast-follows. Don't let the watchdog or brief drafting block the core launch.

---

## 10. Coding conventions & guardrails

- Each automation is a named step inside `routines/intake-pipeline.md`, not a separate file.
- All external calls (SF lookups, Slack sends) go through `scripts/*.mjs` called via Bash — never
  inline fetch calls inside the routine prompt.
- **Salesforce access is READ-ONLY.** The routine checks whether a campaign exists and verifies IDs,
  but never creates or mutates SF records. Campaign creation is delegated to the SF admin via a
  structured Asana spec comment; the routine polls for the admin's reply (an 18-char ID starting
  with `701`) before proceeding to a3/a4.
- **Pardot creation is also delegated to the SF admin** as part of the spec comment — the admin
  links the connected campaign in Account Engagement after creating the SF record.
  `scripts/pardot.mjs` is used only by the sync watchdog (a6) for read-only comparison.
- `scripts/salesforce.mjs create-campaign` / `add-member-statuses` and `scripts/pardot.mjs
  create-campaign` exist for a human to run locally (see README) but are **not called by the
  automated routine** — the live flow only calls `find-campaign`, `query-campaigns`, and
  `get-member-count`.
- **a4's brief is posted to both Asana (system of record) and Slack `#mops-team`** — never Slack-only.
- **All Asana reads/writes use the Asana MCP** — never call the Asana REST API directly.
- **Log every AI decision** to the audit store (Google Sheets) via `node scripts/sheets.mjs log`.
- Secrets come from **environment variables only**; never commit real keys.
- **Idempotency** is enforced by checking `state/processed-tasks.json` before processing any task.
- **Human-in-the-loop:** (1) naming corrections require Asana comment approval before a2 runs;
  (2) SF campaign creation requires the SF admin to create the record and reply with the Campaign ID;
  (3) low-confidence triage is flagged and skipped — a human must clarify before the routine picks it up.
- Prefer **APIs and MCP over Playwright**; only drive a browser where no API exists.

---

## 11. Recommended Agent Skills to author

Build these as `SKILL.md` skills so Claude Code applies them consistently (the description line is
what triggers them — write it to name the trigger):
1. **Naming convention** — validate/correct names; bundle a deterministic validator.
2. **Salesforce campaign creation** — your org's required fields, API names, record types, status
   attach, parent linking, Pardot connected campaign. (Highest "works-in-our-org" value.)
3. **Claude Code routine authoring** — the conventions in §7, state management pattern, the
   `a1→a5→a2` gate sequence, and Bash script calling patterns.
4. (Secondary) Member-status scaffolding, campaign brief format, asset-checklist generation.

---

## 12. Still needs real-org ground truth (resolve during ramp)

These cannot be guessed from training data — confirm against the live org and put the answers in
Google Sheets / `src/config/`:
- The live **Asana intake form fields** and their custom-field GIDs (so `a1` can map them).
- The exact **Salesforce field API names**, record types, and required fields for Campaigns.
- The real **member-status picklists** per type (verify §6.3 matches the org).
- The real **naming edge cases** (abbreviations, multi-region campaigns, programs/parents).
- Pardot/Account Engagement **OAuth setup** and business-unit id.
- Confirm the **region→owner** table (§6.2) and the confidence floor (§6.5).
