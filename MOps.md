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

**Goal:** from a *single* Asana form submission, automatically parse intake, validate the name,
create the Salesforce campaign with the correct member-status scaffolding and the validated name from the previous step, generate the asset
checklist and Asana subtasks, draft a campaign brief, and monitor sync health — turning a
days-long manual process into a minutes-long automated one, with a human only on the uncertain
cases.

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

---

## 3. The six automations

| # | Name | What it does | Key systems |
|---|------|--------------|-------------|
| a1 | Intake triage | Reads the form, classifies type & region, extracts fields, flags missing/contradictory data, routes to the regional owner, sets priority, confirms to requestor | Asana, Claude |
| a2 | SF campaign + statuses | Creates the SF campaign (name, type, dates, budget), applies the member-status set for the type, links parent campaign, creates the Pardot connected campaign | Salesforce, Pardot |
| a3 | Asset checklist + subtasks | Generates the per-type asset checklist and creates every Asana subtask | Asana, Claude |
| a4 | Brief drafting | Turns intake into a one-page brief (objective, audience, messaging, KPIs, assets, timeline); attaches to the Asana task and SF campaign | Claude, Asana, Salesforce |
| a5 | Name generator **(gate)** | Generates the canonical campaign name from intake fields (`Region_Type_Topic_Year_Quarter`), posts it to Asana for owner confirmation, and gates `a2` until approved | Claude |
| a6 | Sync watchdog | Daily scan comparing Pardot vs SF member counts; Slack alert if sync broken >2h; detects orphaned Pardot assets; weekly health report | Pardot, Salesforce, Slack |

---

## 4. Tech stack (decided)

| Layer | Choice | Notes |
|-------|--------|-------|
| Language | **TypeScript / Node.js ESM** | Scripts in `scripts/*.mjs`. Config in `src/config/*.ts`. |
| Build | **Claude Code** | Writes every routine/script. Reads this file for context. |
| Run / host | **Claude Code routines** | Scheduled agents (hourly minimum). No separate run host needed. See §7. |
| Reasoning | **Claude (native)** | The routine *is* Claude — no SDK wrapper needed for reasoning. Claude calls Bash scripts for external systems. |
| Asana | **Asana MCP** | All Asana reads/writes go through the Asana MCP tool (not a custom lib). |
| Connect | Salesforce, Pardot, Slack, Airtable | Plain Node `.mjs` scripts in `scripts/` called via Bash. |
| Config / audit | **Airtable** | Editable rules + per-decision audit log. The team edits a sheet, not code. |
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

1. **Editable rules live in Airtable**, never hardcoded — naming rules, the region→owner routing
   table, member statuses, asset checklists, message templates. Changing a rule = editing a row.
2. **Visibility via Airtable audit log + Slack alerts** — every run logs its decisions to Airtable
   keyed by Asana task ID; failures fire a Slack alert. Owners can see what happened without code.
3. **Human-in-the-loop** on low-confidence classifications (flagged in Asana + Slack) and naming
   corrections (require Asana comment approval before Salesforce is touched).
4. **A named technical escalation contact** in the handoff playbook for breakages no rule edit can fix.

> Honest caveat: this is still a code project. Keep anything that changes often in Airtable; keep the
> routine logic stable and rarely-touched.

---

## 6. Domain ground truth (the rules the automations enforce)

> These values are mirrored in Airtable (and/or `src/config/`) so they can be edited without code.
> The lists below are the current truth; confirm against the live org during the Week 1–2 ramp.

### 6.1 Naming convention
```
[Region]_[Type]_[Topic]_[Year]_[Quarter]
e.g.  EMEA_Webinar_DrupalSecurity_2026_Q3
```
- **Region** — one of `AMER`, `EMEA`, `APJ`, `LATAM` (from intake field, not typed by requestor).
- **Type** — one of `Event`, `Webinar`, `Email`, `Paid`, `Content` (from intake field).
- **Topic** — **Claude generates this** from the intake's `key_message`, `goal`, and `audience`. 1–3 PascalCase words. Specific enough to distinguish this campaign from similar ones; concise enough to scan in a Salesforce dropdown. No spaces, hyphens, or special characters inside the segment. Examples: `DrupalSecurity`, `CloudMigrationSummit`, `MidMarketNurture`.
- **Year** — 4 digits derived from `go_live_date`.
- **Quarter** — `Q1`–`Q4` derived from `go_live_date`.

**How naming works:** The requestor never types a name in this format. Claude derives all five segments from the intake form fields, assembles the canonical name, and posts it to Asana for the regional owner to confirm. The owner approves or provides a one-word adjustment to the Topic segment. The gate blocks `a2` until confirmed.

### 6.2 Region → owner routing
| Region | Owner |
|--------|-------|
| AMER | Harish |
| EMEA | Aayushi |
| APJ | Aayushi |
| LATAM | Felipe |

Escalate if the owner does not respond within **24 hours**.

### 6.3 Member statuses by campaign type (applied by `a2`)
- **Event:** Registered, Attended, No Show, Walk-in, Booth Visit
- **Webinar:** Registered, Attended, No Show, On-Demand View
- **Email:** Sent, Opened, Clicked, Bounced, Unsubscribed
- **Paid / Ad:** Impression, Clicked, Form Fill, Converted
- **Content:** Downloaded, Viewed, Engaged, Converted

### 6.4 Asset checklists by type (turned into Asana subtasks by `a3`)
- **Event:** landing page + form · email invite ×3 · reminder ×2 · follow-up ×2 · SF campaign + child campaigns · speaker brief + run-of-show · post-event attended vs no-show cadence
- **Email:** HTML build + plain text · list-pull segmentation brief · Pardot email record + send config · UTM params · A/B subject variants
- **Paid / Content:** ad copy variants (headline/body/CTA) · landing page + form aligned · UTMs + tracking pixels · content asset to DAM + linked · brief shared with demand-gen lead

### 6.5 Triage guardrails (`a1`)
- Priorities: `standard`, `urgent`, `needs-info`.
- Confidence floor ≈ **0.7** → below it, route to human review.
- Low-confidence or missing/contradictory fields → human review, do not proceed.
- Requestor can override the classification via an Asana comment.
- **Every AI decision is logged per ticket** (audit trail).

### 6.6 Brief inputs/outputs (`a4`)
- In: campaign name, type, owner, audience, region, goal (MQLs / pipeline / awareness / retention), go-live date, budget range, key message, linked/parent programs.
- Out: one-page brief (objective, audience, messaging, KPIs), recommended asset list, timeline with milestones; auto-attached to Asana task + SF campaign.

---

## 7. Claude Code routine conventions (how to write routines)

> The full intake pipeline routine is in `routines/intake-pipeline.md`. The rules below are mandatory.

### How routines work
- A **routine** is a Markdown file in `routines/` that Claude Code executes as a scheduled agent.
- The routine prompt describes every step Claude must take; Claude uses its native reasoning plus
  **Asana MCP** (for all Asana operations) and **Bash** (to call `scripts/*.mjs` for SF, Pardot,
  Slack, Airtable) to carry out the steps.
- Minimum schedule interval is **1 hour**. Intake pipeline runs `0 * * * *`.

### State persistence
- Idempotency is handled via **`state/processed-tasks.json`** — a JSON array of
  `{ id, status, approvedName?, sfCampaignId? }` objects. Claude reads this at the start of
  every run and skips tasks already marked `completed`.
- Statuses: `flagged` | `pending-approval` | `approval-received` | `completed` | `error`.

### Human-in-the-loop
- **Naming corrections**: Claude posts an Asana comment with the suggested fix, sets status to
  `pending-approval`, and polls for "approved" in comments on the next run(s).
- **24-hour escalation**: if no approval after 24 h, a Slack alert fires via
  `node scripts/slack.mjs alert`.

### Calling external systems
All writes to Salesforce, Pardot, Slack, and Airtable go through scripts:
```bash
node scripts/salesforce.mjs create-campaign --name "..." --type "..." ...
node scripts/salesforce.mjs add-member-statuses --campaign-id "..." --type "..."
node scripts/pardot.mjs create-campaign --sf-campaign-id "..." --name "..."
node scripts/slack.mjs alert --message "..."
node scripts/airtable.mjs log --task-id "..." --automation "..." --decision "..."
```
Scripts output JSON on stdout. Claude reads the JSON and handles errors.

### Error handling pattern
- On a recoverable error: adjust the offending field and retry once.
- On a second failure: post an Asana comment with the error, fire a Slack alert, mark the task
  `error` in state, and **continue to the next task** — one failure must never stop the whole run.

### Watchdog (a6) — separate routine
`routines/sync-watchdog.md` runs daily (`0 9 * * *`) and weekly (`0 8 * * 1`):
1. Call `node scripts/salesforce.mjs list-active-campaigns` and `node scripts/pardot.mjs list-campaigns`
2. Compare member counts; flag divergence or sync broken > 2 h
3. `node scripts/slack.mjs alert` the owner; collect orphaned Pardot assets
4. Weekly: build and post a sync-health report

---

## 8. Repository structure

```
mops-ai-automation/
├── MOps.md                        # this file — project memory
├── package.json                   # Node.js deps (for scripts only)
├── .env.example
├── routines/
│   ├── intake-pipeline.md         # Claude Code routine: a1 → a5 gate → a2 → a3 → a4 (hourly)
│   └── sync-watchdog.md           # Claude Code routine: a6 Pardot/SF sync check (daily + weekly)
├── scripts/                       # Node.js ESM scripts called via Bash from routines
│   ├── salesforce.mjs             # create-campaign, add-member-statuses, list-active-campaigns
│   ├── pardot.mjs                 # create-campaign, list-campaigns
│   ├── slack.mjs                  # alert
│   └── airtable.mjs               # log, get-similar
├── state/
│   └── processed-tasks.json       # idempotency state — array of { id, status, ... }
├── src/
│   └── config/                    # editable rules (mirrored in Airtable)
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
| **0 (parallel, blocking)** | **Access + ground truth** | Asana MCP token, Salesforce Connected App, Pardot OAuth, Slack token. Document live SF campaign fields + status sets and the real Asana form fields into Airtable/`src/config/` (fills §6 + §12). *This is the true bottleneck — start it immediately.* |
| **1** | **Scaffold + scripts** | Repo structure, `src/config/` files, stub scripts in `scripts/` (salesforce.mjs, pardot.mjs, slack.mjs, airtable.mjs), `state/processed-tasks.json` init. |
| **2–3** | **Front gate** | `routines/intake-pipeline.md` with a1 triage + a5 naming gate wired up. Test with a mock Asana task. |
| **3–4** | **SF build** | `scripts/salesforce.mjs` create-campaign + add-member-statuses. Wire into routine as STEP 3. *Riskiest integration — leave buffer.* |
| **4–5** | **Generate** | a3 asset checklist via Asana MCP subtask creation + a4 brief posting as Asana comment. |
| **5** | **Watchdog** | `routines/sync-watchdog.md` + `scripts/pardot.mjs` list-campaigns. Schedule daily + weekly. |
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
- All external **writes** (SF create, Slack send) go through `scripts/*.mjs` called via Bash — never
  inline fetch calls inside the routine prompt.
- **All Asana reads/writes use the Asana MCP** — never call the Asana REST API directly.
- **Log every AI decision** to the audit store (Airtable) via `node scripts/airtable.mjs log`.
- Secrets come from **environment variables only**; never commit real keys.
- **Idempotency** is enforced by checking `state/processed-tasks.json` before processing any task.
- **Human-in-the-loop:** naming corrections require an Asana comment approval before a2 runs.
  Low-confidence triage is flagged and skipped — a human must clarify before the routine picks it up.
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
Airtable / `src/config/`:
- The live **Asana intake form fields** and their custom-field GIDs (so `a1` can map them).
- The exact **Salesforce field API names**, record types, and required fields for Campaigns.
- The real **member-status picklists** per type (verify §6.3 matches the org).
- The real **naming edge cases** (abbreviations, multi-region campaigns, programs/parents).
- Pardot/Account Engagement **OAuth setup** and business-unit id.
- Confirm the **region→owner** table (§6.2) and the confidence floor (§6.5).
