# MOps AI Automation — Project Memory (`MOps.md`)

> **Read this first.** This is the single source of truth for the MOps AI Automation project.
> It captures what we're building, why, the rules it must follow, and the conventions for
> building it on Trigger.dev. Place it at the repo root so Claude Code reads it on every run.
> Keep it current — when a decision changes, change it here.
>
> **Naming:** "SF" = Salesforce. Project-management tool = **Asana**.
> **Stack note:** This project is **TypeScript**, because Trigger.dev only supports TypeScript.
> Any earlier Python scaffold is reference only and is superseded by this file.

---

## 1. What this project is

The MOps team is currently the **manual integration layer** between four systems that don't
talk to each other: the Asana intake form, Asana tasks, Salesforce, and Pardot. A human reads
each campaign request and re-keys it into Asana and Salesforce by hand. That is slow, drifts
from naming convention, and silently breaks Pardot–SF sync.

**Goal:** from a *single* Asana form submission, automatically parse intake, validate the name,
create the Salesforce campaign with the correct member-status scaffolding, generate the asset
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
| a5 | Naming enforcer **(gate)** | Validates the name against convention, auto-suggests a correction, and gates `a2` until the name is approved | Claude |
| a6 | Sync watchdog | Daily scan comparing Pardot vs SF member counts; Slack alert if sync broken >2h; detects orphaned Pardot assets; weekly health report | Pardot, Salesforce, Slack |

---

## 4. Tech stack (decided)

| Layer | Choice | Notes |
|-------|--------|-------|
| Language | **TypeScript** | Required by Trigger.dev. Not Python. |
| Build | **Claude Code** | Writes every task/module. Reads this file for context. |
| Run / host | **Trigger.dev (v4)** | Scheduling, retries, queues, dashboard, durable runs. See §7. |
| Reasoning | **Claude** via `@anthropic-ai/sdk` | Model tiering: `claude-haiku-4-5` (classification), `claude-sonnet-4-6` (default — naming, briefs), `claude-opus-4-8` (escalation / ambiguous) |
| Connect | Asana, Salesforce, Pardot, Slack | All via API. See `src/lib/`. |
| Config / audit | **Airtable** | Editable rules + per-decision audit log. The team edits a sheet, not code. |
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
2. **Trigger.dev's dashboard is the visibility layer** — the team can see every run, spot a failed
   one, and re-run it without touching code.
3. **Human-in-the-loop** on low-confidence classifications and the first live writes.
4. **A named technical escalation contact** in the handoff playbook for breakages no rule edit can fix.

> Honest caveat carried from the planning conversation: this is still a code project. Trigger.dev
> gives visibility, not editability of logic. Keep anything that changes often in Airtable; keep the
> logic stable and rarely-touched.

---

## 6. Domain ground truth (the rules the automations enforce)

> These values are mirrored in Airtable (and/or `src/config/`) so they can be edited without code.
> The lists below are the current truth; confirm against the live org during the Week 1–2 ramp.

### 6.1 Naming convention
```
[Year]_[Region]_[Type]_[CampaignName]_[Quarter]
e.g.  2026_EMEA_Webinar_DrupalSecurity_Q3
```
- **Year** — 4 digits, must match the go-live date's year.
- **Region** — one of `AMER`, `EMEA`, `APJ`, `LATAM`.
- **Type** — one of `Event`, `Webinar`, `Email`, `Paid`, `Content`.
- **CampaignName** — PascalCase, no spaces or separators inside it.
- **Quarter** — `Q1`–`Q4`, must match the go-live date's calendar quarter.
- A malformed name is **auto-corrected and proposed back**, but still needs approval before `a2`.

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

## 7. Trigger.dev v4 conventions (how to write tasks)

> Full examples are in `trigger-ref.md`. The rules below are mandatory.

- Import from **`@trigger.dev/sdk`**. Use **`task()`**, **`schedules.task()`**, **`schemaTask()`**.
- **NEVER** use v2 syntax (`client.defineJob(...)`) — it breaks everything.
- **Orchestrator + processor pattern:** a scheduled task polls for new items and triggers a
  processor task per item with an **idempotency key**. Imports between task files use the **`.js`**
  extension.
- **Idempotency keys** prevent duplicate processing (e.g. `campaign-${asanaTaskId}`). Always use
  them when the same item could be triggered twice (e.g. a poller seeing it in two windows).
- **`triggerAndWait` returns a `Result` object, not the raw output.** Check `result.ok` then use
  `result.output`, or call `.unwrap()` to throw on failure.
- **NEVER** wrap `triggerAndWait`, `batchTriggerAndWait`, or `wait.*` in `Promise.all`. Run them
  with separate sequential `await`s.
- **Retries** are configured per task (`maxAttempts`, `factor`, `min/maxTimeoutInMs`). Throw to retry.
- **Waits > 5s are auto-checkpointed** — no compute consumed while waiting.
- **`wait.forToken`** is how we implement human approval (the naming-correction approval and the
  first-live-write approval) without burning compute.
- Cron: watchdog daily `0 9 * * *`; weekly report `0 8 * * 1`; intake poller `*/5 * * * *`.

### Orchestrator skeleton (the gate lives here)
```ts
// src/trigger/intake-pipeline.ts
import { task } from "@trigger.dev/sdk";
import { a1IntakeTriage } from "./a1-intake-triage.js";
import { a5NamingEnforcer } from "./a5-naming-enforcer.js";
import { a2SfCampaign } from "./a2-sf-campaign.js";
import { a3AssetChecklist } from "./a3-asset-checklist.js";
import { a4BriefDrafting } from "./a4-brief-drafting.js";

export const intakePipeline = task({
  id: "intake-pipeline",
  run: async (payload: { asanaTaskId: string }) => {
    // 1. Triage
    const triage = await a1IntakeTriage
      .triggerAndWait({ asanaTaskId: payload.asanaTaskId })
      .unwrap();
    if (triage.needsHuman) return { stoppedAt: "a1", reason: "low confidence / missing fields" };

    // 5. Naming GATE — must pass before a2
    const gate = await a5NamingEnforcer
      .triggerAndWait({ asanaTaskId: payload.asanaTaskId, classification: triage.classification })
      .unwrap();
    if (!gate.approved) {
      return { stoppedAt: "a5", reason: gate.reason, suggestedName: gate.suggestedName };
    }

    // 2. Build SF campaign (+ statuses + Pardot) — only reached because the gate passed
    const build = await a2SfCampaign
      .triggerAndWait({ name: gate.approvedName, classification: triage.classification, owner: triage.owner })
      .unwrap();

    // 3 + 4. Assets and brief — sequential awaits (NEVER Promise.all on triggerAndWait)
    await a3AssetChecklist
      .triggerAndWait({ asanaTaskId: payload.asanaTaskId, classification: triage.classification })
      .unwrap();
    await a4BriefDrafting
      .triggerAndWait({ asanaTaskId: payload.asanaTaskId, classification: triage.classification })
      .unwrap();

    return { ok: true, sfCampaignId: build.sfCampaignId };
  },
});
```

### Intake ingestion — polling (default; no extra infra)
```ts
// src/trigger/intake-poller.ts
import { schedules } from "@trigger.dev/sdk";
import { intakePipeline } from "./intake-pipeline.js";
import { fetchNewSubmissions } from "../lib/asana.js";

export const intakePoller = schedules.task({
  id: "intake-poller",
  cron: "*/5 * * * *", // every 5 minutes
  run: async () => {
    const submissions = await fetchNewSubmissions();
    for (const s of submissions) {
      await intakePipeline.trigger(
        { asanaTaskId: s.id },
        { idempotencyKey: `campaign-${s.id}` }, // never process the same task twice
      );
    }
    return { dispatched: submissions.length };
  },
});
```
> Alternative: a tiny webhook endpoint that calls `tasks.trigger("intake-pipeline", …)` for
> real-time intake. Polling is the default because it needs no always-on server.

### Watchdog (a6) — scheduled
```ts
// src/trigger/a6-sync-watchdog.ts
import { schedules } from "@trigger.dev/sdk";

export const syncWatchdog = schedules.task({
  id: "a6-sync-watchdog",
  cron: "0 9 * * *", // daily 09:00 UTC
  run: async () => {
    // 1. list active SF campaigns with a Pardot connected campaign
    // 2. compare member counts; flag divergence / sync broken > 2h
    // 3. Slack-alert the owner; collect orphaned Pardot assets
    // 4. (weekly run) build the sync-health report
    return { findings: 0 };
  },
});
```

---

## 8. Repository structure (TypeScript)

```
mops-ai-automation/
├── MOps.md                       # this file — project memory
├── trigger-ref.md                # Trigger.dev v4 API reference
├── trigger.config.ts             # Trigger.dev project config
├── package.json / tsconfig.json
├── .env.example
├── src/
│   ├── trigger/                  # Trigger.dev tasks (auto-discovered)
│   │   ├── intake-poller.ts      # schedules.task → triggers the pipeline
│   │   ├── intake-pipeline.ts    # orchestrator: a1 → a5 gate → a2 → a3 → a4
│   │   ├── a1-intake-triage.ts
│   │   ├── a2-sf-campaign.ts
│   │   ├── a3-asset-checklist.ts
│   │   ├── a4-brief-drafting.ts
│   │   ├── a5-naming-enforcer.ts
│   │   └── a6-sync-watchdog.ts   # schedules.task (daily + weekly)
│   ├── lib/                      # integration clients (one per system)
│   │   ├── asana.ts  salesforce.ts  pardot.ts  slack.ts  airtable.ts
│   ├── ai/
│   │   ├── claude.ts             # Anthropic SDK wrapper + model tiering
│   │   ├── prompts.ts            # prompt builders, out of the task logic
│   │   └── schemas.ts            # Zod schemas (shared with schemaTask payloads)
│   └── config/                   # editable rules (or loaded from Airtable)
│       ├── naming-rules.ts  routing.ts  member-statuses.ts  asset-checklists.ts
└── e2e/
    └── intake.spec.ts            # Playwright: submit the form, assert the pipeline ran
```

---

## 9. Build plan — fast-track sprint (~2 weeks)

> **Goal: ship as fast as possible.** With Claude Code, the coding collapses to days. The real
> pace-setters are **access/credentials** and **ground truth** (§12), not typing — so secure those
> on Day 0 in parallel, or the rest of the plan stalls. Day numbers are working days.

| Day(s) | Milestone | Deliverable |
|--------|-----------|-------------|
| **0 (parallel, blocking)** | **Access + ground truth** | Asana token, Salesforce Connected App, Pardot OAuth, Slack token. Document live SF campaign fields + status sets and the real Asana form fields into Airtable/`src/config/` (fills §6 + §12). *This is the true bottleneck — start it immediately.* |
| **1** | **Scaffold + clients** | Trigger.dev repo (`trigger.config.ts`, task stubs) + `lib/` clients (Asana, Salesforce, Pardot, Slack, Airtable). |
| **2–3** | **Front gate** | `a1` triage + `a5` naming enforcer + the `intake-pipeline` orchestrator with the gate (`a1 → a5`). End-to-end on test intake. |
| **3–4** | **SF build** | `a2` SF campaign + member-status scaffolding + Pardot connected campaign. *Riskiest integration — leave buffer.* |
| **4–5** | **Generate** | `a3` asset checklist/subtasks + `a4` brief drafting. |
| **5** | **Watchdog** | `a6` scheduled sync watchdog + Slack alerts. |
| **6** | **QA** | Playwright e2e (submit the real form → assert the pipeline ran); fix bugs; idempotency + retry check. |
| **7** | **UAT + go-live** | UAT with one regional owner; handoff playbook; go live with **human-in-the-loop on first live SF writes** (`wait.forToken`). |

Build order in code: `lib/asana.ts` → `a1` + `a5` → `lib/salesforce.ts` + `a2` → `a3`/`a4` →
`lib/pardot.ts` + `a6`.

**To go even faster / de-risk:** ship a **thin slice first** — `a1 → a5 → a2` only (form in →
correctly-named SF campaign with statuses out). That alone kills the two biggest pain points
(manual intake, no naming enforcement) and can be live in **~3–4 days**. Add `a3`/`a4`/`a6` as
fast-follows. Don't let the watchdog or brief drafting block the core launch.

---

## 10. Coding conventions & guardrails

- Each automation is its own Trigger.dev task exposing a typed payload (use `schemaTask` + Zod where
  validation matters).
- All external **writes** (SF create, Slack send, Asana update) go through a `lib/` client — never
  inline `fetch` in a task.
- **Log every AI decision** to the audit store (Airtable) keyed by the Asana task id.
- Secrets come from **environment variables only**; never commit real keys.
- Use **idempotency keys** on every triggered run so retries/re-polls don't double-create records.
- **Human-in-the-loop:** gate live SF creation behind `wait.forToken` until a person approves, at
  least until the system has proven itself; route low-confidence triage to a human.
- Prefer **APIs over Playwright**; only drive a browser where no API exists.

---

## 11. Recommended Agent Skills to author

Build these as `SKILL.md` skills so Claude Code applies them consistently (the description line is
what triggers them — write it to name the trigger):
1. **Naming convention** — validate/correct names; bundle a deterministic validator.
2. **Salesforce campaign creation** — your org's required fields, API names, record types, status
   attach, parent linking, Pardot connected campaign. (Highest "works-in-our-org" value.)
3. **Trigger.dev task authoring** — the conventions in §7 and the `a1→a5→a2` gate sequence.
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
