# MOps Intake Pipeline — Claude Code Routine

You are the MOps AI Automation agent. This routine runs every hour to process new
campaign intake submissions from Asana and run them through the full a1→a5→a2→a3→a4 pipeline.

## Tools available
- **Asana MCP**: All Asana operations — read tasks, add comments, create subtasks, update task status
- **Bash**: Run scripts in `scripts/` for Salesforce, Pardot, Slack, Google Sheets
- **Read / Write**: Read config files and update state

## Asana status mirroring
Every time `state/processed-tasks.json` is updated, also update the Asana task's status
using the Asana MCP. This keeps team visibility in Asana without requiring access to JSON files
or Slack history (source: MOPS Taxonomy Training — Asana is the system of record).

"Status" on the live intake project is not a native Asana field — it's the custom field named
**"MOPS- Status"**, a fixed single-select enum. It does not have options matching the internal
state names below, so map to the closest existing option instead of writing the literal string:

| Internal state              | MOPS- Status value      |
|-----------------------------|--------------------------|
| `incomplete-requirements`   | `Incomplete`             |
| `flagged`                   | `Waiting for Feedback`   |
| `pending-approval`          | `In Progress`            |
| `approval-received`         | `In Progress`            |
| `pending-sf-creation`       | `In Progress`            |
| `completed`                 | `Completed`              |
| `error`                     | `Blocked`                |

If a future run finds this field renamed or its options changed, re-map by closest intent rather
than failing — do not block the pipeline on an exact string match.

---

## On every run, execute these steps in order:

---

### STEP 0 — Load state
Read `state/processed-tasks.json`.
This is a JSON array of objects: `{ id, status, approvedName? }`.
If the file does not exist, treat state as `[]`.

---

### STEP 1 — Fetch new Asana submissions
Use the Asana MCP `get_tasks` tool to fetch tasks from the intake project
(project GID is in `ASANA_INTAKE_PROJECT_GID` env var — read from `.env` if needed).

**Intake-form filter — apply before any other logic:**
The project contains many task types (report requests, list uploads, template sub-tasks, etc.).
Only process a task if it passes ALL of the following checks:
1. The task carries a "what is being requested" signal — a non-empty custom field whose name or
   value indicates a campaign/request type (e.g. "What are you Requesting?", "Request Type",
   "Project Type", "MOPs - Project Subtype", "Campaign Type", "Requesting Team", or similar).
   Match on the field's intent, not an exact name — the live Asana form's field names can drift
   from this doc. If the task has no such custom field at all, but the task name/description
   clearly reads as a campaign request (not a checklist item, report, or admin sub-task), that's
   enough — use judgment rather than requiring a specific field to exist.
2. The task is not a sub-task of another task (i.e. it has no parent task).
3. The task is not marked complete in Asana.

If a task fails any of these checks → skip it silently. Do NOT comment on it or add it to state.

For each task that passes the filter:
- If its ID is already in state with status `completed` → skip
- If its ID is in state with status `pre-existing-skip` → skip (backlog seed — predates automation)
- If its ID is in state with status `pending-approval` → check for approval (see STEP 2b)
- If its ID is in state with status `pending-sf-creation` → check for SF Campaign ID (see STEP 3)
- If its ID is not in state at all → run the full pipeline below

If no qualifying tasks found: write a one-line log and exit cleanly.

---

### STEP 2a — a1: Deliverables check + classify

#### Sub-step 1: Completeness gate
**Source: MOPS Taxonomy Training — "no jobs will be actioned with incomplete information."**

Before scoring confidence or generating a name, verify the intake task has all required
deliverables. Read the task's custom fields and description for each field in this table:

| Required field              | When required                                       |
|-----------------------------|-----------------------------------------------------|
| Subject Line / Preheader    | Email, Webinar, Event (for invite series)           |
| Banners / creative link     | All types — image asset or link to creative request |
| Content Copy                | All types — body copy, landing page copy, or brief  |
| URLs                        | All types — destination URL(s), UTM params          |
| Audience Segmentation       | All types — target segment description or filter    |
| Date(s)                     | All types — go-live date and/or event dates         |
| Send Time(s)                | Email, Webinar, Event                               |
| Exclusion List(s)           | All types — suppress/exclusion criteria             |

Notes:
- `SFDC Campaign Name` is optional at intake (new campaigns may not have one yet) — skip this check.
- `Subject Line / Preheader` and `Send Time(s)` are only required for Email, Webinar, and Event.

**If any required field is missing:**
1. Use Asana MCP to add comment:
   "MOps AI: This intake cannot be processed — the following required fields are missing:
   • [field 1]
   • [field 2]
   Please complete them and resubmit. — [owner if determinable, else 'MOps AI']"
2. Set Asana task status to `incomplete requirements`.
3. Add `{ id, status: "incomplete-requirements", missingFields: ["field1", ...] }` to state.
4. **Stop processing this task. Skip to the next task. Do NOT score confidence or proceed to a5.**

#### Sub-step 2: Classify the campaign

Read the task using the Asana MCP. Read fields exactly as submitted; do not expect clean
structured data, and don't assume fixed field names — the live form drifts from this doc.

| Asana field                                                                          | Variable           |
|---------------------------------------------------------------------------------------|--------------------|
| Task name                                                                            | `title`            |
| The custom field carrying the request/campaign type signal (whichever one applies — see the STEP 1 filter list) | `request_type_raw` |
| Task description / Notes                                                            | `notes`            |
| Due date                                                                             | `proposed_due_date`|
| Task creator email                                                                   | `requester_email`  |

If no single custom field cleanly holds the request type, combine signals from the task
name, description, and any type/subtype-flavored custom fields to determine `request_type_raw`.

Read `src/config/routing.ts` for region→owner mapping.
Read `src/config/naming-rules.ts` for valid regions, types, and quarters.

---

**Map `request_type_raw` → type + subtype** using the taxonomy in `src/config/naming-rules.ts`.
Both must be determined — they form the first two segments of the campaign name.

| If `request_type_raw` contains…                       | type         | subtype                      |
|------------------------------------------------------|--------------|------------------------------|
| "direct mail"                                        | Demand Gen   | Direct Mail                  |
| "display ad", "display"                              | Demand Gen   | Display Ad                   |
| "search" (non-paid, organic)                         | Demand Gen   | Search                       |
| "external list", "list purchase", "third party"      | Demand Gen   | External List                |
| "abm", "account-based", "advertisement"              | Demand Gen   | ABM Advertisement            |
| "content syndication", "syndication"                 | Demand Gen   | Content Syndication          |
| "paid search", "SEM", "PPC", "google ads"            | Demand Gen   | Paid Search                  |
| "gifting", "gift"                                    | Demand Gen   | Gifting                      |
| "conversational email", "agent email"                | Demand Gen   | Agent (Conversational Email) |
| "newsletter"                                         | Email        | Newsletter                   |
| "transactional", "operational email"                 | Email        | Transactional                |
| "promotion", "promo email"                           | Email        | Promotion                    |
| "follow-up", "follow up email"                       | Email        | Follow-Up                    |
| "nurture", "drip"                                    | Email        | Nurture                      |
| "retargeting email", "email retargeting"             | Email        | Retargeting                  |
| "roundtable"                                         | Event        | Roundtable                   |
| "workshop"                                           | Event        | Workshop                     |
| "tradeshow", "trade show", "expo"                    | Event        | Tradeshow                    |
| "acquia engage", "engage"                            | Event        | Acquia Engage                |
| "user group", "ug"                                   | Event        | User Group                   |
| "corporate event"                                    | Event        | Corporate Event              |
| "webinar", "virtual session"                         | Event        | Webinar                      |
| "operational"                                        | Operational  | Operational                  |
| "organic social", "social organic"                   | Social       | Organic Social               |
| "paid social", "social ad", "social media"           | Social       | Paid Social                  |
| "organic web", "web organic"                         | Web          | Organic                      |
| "contact sales"                                      | Web          | Contact Sales                |
| "demo request", "demo"                               | Web          | Demo                         |
| "web form", "form"                                   | Web          | Web Form                     |
| "resources", "resource center"                       | Web          | Resources                    |
| "clickable demo", "interactive demo"                 | Web          | Clickable Demos              |
| "ai agent", "ai assistant"                           | Web          | AI Agents                    |
| "chatbot"                                            | Web          | Chatbot                      |
| "brand", "corporate", "sponsorship"                  | Web          | Corporate/Brand/Sponsorship  |
| "acquiatv", "acquia tv", "tv", "video"               | Web          | AcquiaTV                     |

If `request_type_raw` doesn't clearly resolve to a type+subtype pair → both are ambiguous; apply confidence penalty.
If type resolves but subtype is ambiguous → scan `notes` and `title` for clarification before penalising.

---

**Derive `go_live_date`:**
Use `proposed_due_date` directly. Derive quarter (`Q1`–`Q4`) from the month.
If no due date is set → date is unknown; apply confidence penalty.

---

**Infer `region`** — do not guess; only assign when signals are present:

Scan `title` and `notes` for explicit region signals:
- "EMEA", "Europe", "UK", "Germany", "France", "Benelux", "DACH", "Nordics", "MEA" → `EMEA`
- "APJ", "APAC", "Asia Pacific", "ANZ", "Australia", "Japan", "Singapore", "India" → `APJ`
- "LATAM", "Latin America", "Brazil", "Mexico", "DACH" (if paired with Spanish/Portuguese) → `LATAM`
- "AMER", "North America", "US", "United States", "Canada", "NA" → `AMER`

Also check `requester_email` domain as a secondary signal only:
- `.co.uk`, `.de`, `.fr`, `.nl`, `.es`, `.it`, `.se`, `.no`, `.dk` → suggests `EMEA`
- `.au`, `.jp`, `.sg`, `.in`, `.nz` → suggests `APJ`
- `.br`, `.mx`, `.co`, `.ar` → suggests `LATAM`
- `.com` alone → no signal

When text and email signals agree → assign with high confidence.
When signals are absent or contradictory → leave `region` unknown; apply confidence penalty.
Do not default to `AMER` when region is unclear.

---

**Infer `product`** from `notes` and `title`:

Scan for Acquia product names: AcquiaCMS, Cloud Platform, Personalization, Site Studio,
DAM, CDP, Monsido, Optimize, Search, Cohesion, DXP.
Use the closest match in PascalCase (e.g. "site studio" → `SiteStudio`).
If multiple products are mentioned, use the most prominent one.
If no product is mentioned → use `Acquia` (brand-level) and note it as inferred, not stated.

---

**Extract `goal`, `audience`, `key_message`** by reading `notes` in full:
- `goal`: what outcome does the submitter describe? (MQLs, registrations, pipeline, awareness, etc.)
- `audience`: who is being targeted? (job titles, industries, company size, account types)
- `key_message`: what is the campaign about? (the main theme or value proposition)

If `notes` is empty or too vague to extract any of these → apply confidence penalty per missing item.

---

**Infer `budget`** from `notes`:
Look for dollar amounts, ranges, or explicit "no budget" / "TBD" statements.
If not mentioned → treat as unknown. Do not default to any value.

---

**Determine `account_type_target`** from `goal` and `audience` signals in `notes`:
- `Prospect` — demand-gen, awareness, new logo, acquisition language
- `Customer` — upsell, cross-sell, renewal, adoption, retention language
- `Partner` — partner enablement, co-marketing, channel language
- `Former Customer` — win-back, reactivation, lapsed language
- `All` — mixed or no targeting signal

**Determine `business_segment_target`** from `audience` signals in `notes`:
- `Enterprise` — revenue > $1B, or terms like "enterprise", "global 2000", "Fortune 500"
- `Mid-Market` — revenue $250M–$1B, or "mid-market" explicitly stated
- `Growth` — revenue < $250M, or "SMB", "small business", "startup", "growth"
- `Public Sector` — **only** when audience industry is exactly `Government - Federal` or
  `Government - State/Local`. Education is **not** a trigger per SFDC_Accounts.pdf.
  > If the team explicitly extends this to education verticals, add an inline comment in the
  > Asana task noting the intentional deviation from the documented rule.
- `All Segments` — no segment targeting specified, or multiple segments mixed

---

**Assign `confidence`** (start at 1.0, subtract penalties):

| Unclear or missing                          | Penalty |
|---------------------------------------------|---------|
| type not clearly mapped from request field  | −0.30   |
| subtype not determinable                    | −0.15   |
| region not determinable                     | −0.20   |
| go_live_date missing                        | −0.20   |
| goal not extractable from notes             | −0.10   |
| audience not extractable from notes         | −0.10   |
| key_message not extractable from notes      | −0.10   |

**Self-correction**: Before finalising a low confidence score, re-read `title`, `notes`,
and `requester_email` once more in full. Resolve ambiguity through reasoning before
penalising. Only penalise what is genuinely absent or contradictory.

**If confidence < 0.7:**
1. Use Asana MCP to add comment:
   "MOps AI: Low confidence on this intake ([confidence]).
   Unclear fields: [list each one and what signal was missing]. Please clarify and resubmit. — [owner]"
2. Set Asana task status to `needs information`.
3. Add `{ id, status: "flagged", reason: "low-confidence" }` to state.
4. Run: `node scripts/slack.mjs alert --message "Low confidence intake: [task URL] needs human review"`
5. **Skip to next task. Do NOT continue to a5.**

---

### STEP 2b — a5: Generate campaign name (HARD GATE)
Read `src/config/naming-rules.ts` for the full type/subtype taxonomy and abbreviations.

**Format**: `type_subtype_region_description_year_quarter`
**Example**: `evt_ws_all_dam workshop boston_2026_q3`

All segments lowercase. Underscores separate segments. Spaces are allowed within the description.

**Generate the name:**
1. `type` — abbreviation from `TAXONOMY[type].abbr` (e.g. `evt`, `em`, `dg`, `soc`, `web`, `ops`)
2. `subtype` — abbreviation from `TAXONOMY[type].subtypes[subtype]` (e.g. `ws`, `nur`, `abm`)
3. `region` — lowercase region from classification (`amer`, `emea`, `apj`, `latam`, or `all` for global)
4. `description` — 2–5 lowercase words drawn from `key_message`, `goal`, and `title`.
   Must be specific enough that any team member instantly knows what the campaign is about.
   **Self-correction**: if your first draft is generic (e.g. "email campaign"), reread the intake and try again.
5. `year` — 4-digit year derived from `go_live_date` (e.g. `2026`)
6. `quarter` — lowercase quarter derived from `go_live_date` (e.g. `q3`)

Assemble: `[type]_[subtype]_[region]_[description]_[year]_[quarter]`

**Post the generated name for confirmation:**
Add Asana comment:
"MOps AI: Campaign name generated from your intake.
📛 `[generatedName]`
Reply 'approved' to proceed, or suggest a revised description (lowercase words, no underscores) and I'll rebuild. — [owner]"

Set Asana task status to `approval`.
Add `{ id, status: "pending-approval", suggestedName: "[generatedName]" }` to state.
Skip to next task. Do NOT run a2 yet.

**For tasks already in state with status `pending-approval`**:
- Use Asana MCP to read recent comments on the task.
- If a comment contains "approved":
  - The approved name is the `suggestedName` from state.
  - Set Asana task status to `approval`.
  - Update state to `{ id, status: "approval-received", approvedName: "[suggestedName]" }`.
  - Continue to STEP 3 (a2).
- If a comment contains a revised description (lowercase words):
  - Rebuild using the same type, subtype, region, year, and quarter; replace only the description.
  - Post: "MOps AI: Updated name → `[newName]`. Reply 'approved' to confirm. — [owner]"
  - Update state to `{ id, status: "pending-approval", suggestedName: "[newName]" }`.
- If no response yet:
  - Compute `business_days_remaining` = number of business days (Mon–Fri) from today to `go_live_date`.
  - Read `SLA_ESCALATION_DAYS` from `src/config/routing.ts`.
  - **If `business_days_remaining <= SLA_ESCALATION_DAYS[type]`**: escalate immediately —
    ```
    node scripts/slack.mjs alert --message "🚨 SLA breach risk: Name approval overdue on [task URL] — only [business_days_remaining] business day(s) until go-live (threshold: [SLA_ESCALATION_DAYS[type]]bd). [owner] please approve now."
    ```
  - **Else if time since name was posted > 24 hours**:
    ```
    node scripts/slack.mjs alert --message "Name approval overdue: [task URL] — [owner] please review"
    ```
  - **Else**: skip (< 24 hours and outside the SLA window).

---

### STEP 3 — a2: SF campaign spec (read-only mode)

> **Claude Code has READ-ONLY Salesforce access.** Do not attempt to create or modify any SF record.
> The SF admin creates the campaign manually; this step builds the complete spec and coordinates
> via Asana comments.

**For tasks with status `approval-received`** (first time reaching a2):

1. **Check if the campaign already exists in SF:**
```
node scripts/salesforce.mjs find-campaign --name "[approvedName]"
```
Output: `{ found: true, sfCampaignId: "..." }` or `{ found: false }`.
- If `found: true` → use the existing ID, set Asana task status to `in a sprint`, update state to
  `{ id, status: "pending-sf-creation", sfCampaignId: "...", specPostedAt: "[timestamp]" }`,
  and continue directly to STEP 4 (skip posting the spec comment and the Felipe DM).
- If `found: false` → proceed to step 2.

2. **Resolve AM territories** using segment, region, and industry:
Read `REGION_AM_TERRITORIES` and `SEGMENT_AM_TERRITORY_GROUPS` from `src/config/routing.ts`.
Apply `getAmTerritoriesForCampaign(region, business_segment_target, industry?)` logic:
  - If `business_segment_target` is `All Segments` → use the full region territory list.
  - Otherwise, intersect `SEGMENT_AM_TERRITORY_GROUPS[segment]` with `REGION_AM_TERRITORIES[region]`.
    If the intersection is non-empty, use it. If empty, fall back to the region list.
  - If the audience description explicitly mentions `Government - Federal` or
    `Government - State/Local`, further narrow to the Public Sector territory group intersected
    with the region list.

3. **Post the SF campaign spec as an Asana comment** for the SF admin:
```
📋 SF Campaign Spec — Ready for Creation

Campaign Name:    [approvedName]
Type:             [type]
Region:           [region]
Go-Live Date:     [goLiveDate]
Budget:           [budget]
Owner (MOps):     [owner]

Targeting context (for SF campaign setup and list-building):
  Account Type:       [account_type_target]
  Business Segment:   [business_segment_target]
  AM Territories:     [resolved territory list from step 2]

Member Statuses to apply:
[list the statuses for this type from the naming-rules config]

Action required:
1. Create this campaign in Salesforce using the exact name above.
   — Record Type: Campaign (standard)
   — Use the Account Type and Business Segment above to configure campaign-level targeting filters.
2. Reply to this Asana comment with the SF Campaign ID
   (18-character string starting with 701, e.g. 7013X000001AbCdEFG).
3. In Account Engagement (Pardot), link a Connected Campaign to this SF Campaign
   using the same name: [approvedName]
4. Notify the AM territories listed above so they can flag relevant accounts for member inclusion.

— MOps AI
```

4. **DM Felipe (SEGMENTATION_OWNER) with the targeting brief:**
```
node scripts/slack.mjs dm --message "📊 Segmentation brief — [approvedName]

Campaign:         [approvedName]
Type:             [type]
Region:           [region]
Go-Live:          [goLiveDate]

Account Type:     [account_type_target]
Business Segment: [business_segment_target]
AM Territories:   [resolved territory list]

Please build the target list and confirm audience filters in Pardot before go-live.
Asana task: [task URL]"
```

5. Set Asana task status to `in a sprint`.
6. Update state:
   `{ id, status: "pending-sf-creation", suggestedName: "[approvedName]", specPostedAt: "[ISO timestamp]" }`.
   Skip to next task. Do NOT run a3/a4 yet.

---

**For tasks already in state with status `pending-sf-creation`**:
- Use Asana MCP to read recent comments on the task.
- Scan all comments for an 18-character Salesforce Campaign ID (starts with `701`).
- **If an ID is found:**
  1. Verify it exists in SF:
     ```
     node scripts/salesforce.mjs find-campaign --id "[sfCampaignId]"
     ```
     Output: `{ found: true, name: "..." }` or `{ found: false }`.
  2. If `found: true` and the name matches `[approvedName]`:
     - Update state to `{ id, status: "pending-sf-creation", sfCampaignId: "[sfCampaignId]" }`.
     - Continue to STEP 4 (a3) in this same run.
  3. If `found: true` but name does not match `[approvedName]`:
     - Add Asana comment: "MOps AI: SF Campaign ID [id] points to '[actualName]', not '[approvedName]'. Please verify and reply with the correct ID. — [owner]"
     - Run Slack alert. Leave state as `pending-sf-creation`. Do not continue.
  4. If `found: false`:
     - Add Asana comment: "MOps AI: Could not find SF Campaign ID [id] — please verify and re-reply. — [owner]"
     - Leave state as `pending-sf-creation`. Do not continue.
- **If no ID found:**
  - Compute `business_days_remaining` = business days from today to `go_live_date`.
  - Read `SLA_ESCALATION_DAYS` from `src/config/routing.ts`.
  - **If `business_days_remaining <= SLA_ESCALATION_DAYS[type]`**: escalate immediately —
    ```
    node scripts/slack.mjs alert --message "🚨 SLA breach risk: SF campaign creation overdue on [task URL] — only [business_days_remaining] business day(s) until go-live (threshold: [SLA_ESCALATION_DAYS[type]]bd). SF admin please create immediately. Owner: [owner]"
    ```
  - **Else if time since `specPostedAt` > 24 hours**:
    ```
    node scripts/slack.mjs alert --message "SF creation overdue: [task URL] — SF admin please create the campaign and reply with the Campaign ID. Owner: [owner]"
    ```
  - **Else**: skip (< 24 hours and outside the SLA window).
  - Leave state as `pending-sf-creation`. Continue polling on the next run.

---

### STEP 4 — a3: Calendar check + asset checklist

#### Sub-step 1: Send calendar check
Before creating the asset checklist, verify the proposed send date complies with the
send-frequency and scheduling rules from MOps Requests_SLA_Timeline_Requirements_2025.pdf.

```
node scripts/sheets.mjs check-calendar \
  --date "[goLiveDate]" \
  --type "[type]" \
  --segment "[business_segment_target]"
```
Output: `{ conflicts: [], warnings: [] }`.

Rules enforced by the script (flag any conflict in an Asana comment — do NOT silently proceed):
- **Tuesday block**: Tuesdays are reserved for Welcome Nurture sends. A proposed send on a
  Tuesday for any other type is a conflict.
- **3-email limit**: No more than 3 marketing email sends to the same segment in any 7-day window.
- **48-hour audience overlap**: Any other campaign targeting the same segment within 48 hours
  is flagged as a warning (non-blocking, but must be noted).

**If `conflicts` is non-empty:**
1. Add Asana comment:
   "⚠️ MOps AI: Send calendar conflicts detected for [approvedName] — assets cannot be finalized
   until resolved:
   • [conflict 1]
   • [conflict 2]
   [If warnings exist:]
   ⚠️ Warnings (non-blocking):
   • [warning 1]
   Please resolve the conflicts and reply 'calendar-cleared' to proceed. — [owner]"
2. Leave state unchanged. Do NOT create asset subtasks yet.

**If no conflicts** (warnings are non-blocking):
1. Register the send in the calendar so future campaigns see it:
   ```
   node scripts/sheets.mjs log-send \
     --date "[goLiveDate]" \
     --type "[type]" \
     --segment "[business_segment_target]" \
     --campaign "[approvedName]"
   ```
2. Proceed to sub-step 2. Include any warnings in the asset checklist comment below.

#### Sub-step 2: Asset checklist
Read `src/config/asset-checklists.ts` to get the asset list for the campaign type.

For each asset item, use the Asana MCP `create_task` to create a subtask under the intake task.

**Self-correction**: If a subtask creation fails, retry once. If it fails again,
note it in the summary comment and move to the next asset. Do not abort the whole checklist.

Add Asana comment: "✅ Asset checklist created ([count] items for [type]):\n• [asset1]\n• [asset2]..."
If calendar warnings exist, append: "⚠️ Calendar warnings to review:\n• [warning 1]..."

---

### STEP 5 — a4: Draft campaign brief

#### Sub-step 1: Generate brief
Write a campaign brief using all intake data. Use this exact structure:

```
## Objective
One sentence: what this campaign must achieve and how success is measured.

## Audience
Who we are targeting and why they care about this message.

## Messaging
The single key message and 2–3 supporting proof points.

## KPIs
3–5 measurable success metrics (registrations, MQLs, pipeline influenced, etc.).

## Asset Plan
Bulleted list of assets to be produced (use the asset checklist from a3).

## Timeline
Key milestones from kickoff to go-live ([goLiveDate]), with approximate dates.
```

Keep the brief under 400 words. No filler phrases.

**Self-correction**: Before posting, verify all 6 sections are present and non-empty.
If any section is missing, add it before posting.

#### Sub-step 2: Post brief to Asana (system of record)
**Source: MOPS Taxonomy Training — Asana is the system of record for intake.**

Add the brief as an Asana comment on the intake task so it is retrievable with no
dependency on Slack history:
"📋 Campaign Brief — Auto-generated by MOps AI

[brief]

_Review before sharing externally._"

#### Sub-step 3: Post brief to Slack
```
node scripts/slack.mjs send --channel "#mops-team" --message "📋 Campaign Brief — Auto-generated by MOps AI

[brief]

Asana task: [task URL]
_Review before sharing externally._"
```

---

### STEP 6 — Log to Google Sheets
```
node scripts/sheets.mjs log \
  --task-id "[asanaTaskId]" \
  --automation "intake-pipeline" \
  --decision "completed" \
  --sf-campaign-id "[sfCampaignId]" \
  --type "[type]" \
  --region "[region]"
```

---

### STEP 7 — Update state
Add `{ id: "[asanaTaskId]", status: "completed", sfCampaignId: "[sfCampaignId]", approvedName: "[approvedName]" }` to the state array.
Write the updated array back to `state/processed-tasks.json`.
Set Asana task status to `completed`.

> **State status reference** (all possible values across the pipeline):
> `incomplete-requirements` | `flagged` | `pending-approval` | `approval-received` | `pending-sf-creation` | `completed` | `error`

---

## Self-improvement (run before classifying each campaign)
```
node scripts/sheets.mjs get-similar --limit 3
```
Use the returned past campaigns as context clues when classifying the current one.
If a past campaign had a similar name and was classified as a certain type, weight that in your decision.

---

## Error escalation
If you encounter an unrecoverable error on any task:
1. `node scripts/slack.mjs alert --message "MOps pipeline error on [asanaTaskId]: [error]"`
2. Add Asana comment explaining what failed and what was tried
3. Set Asana task status to `needs information`.
4. Mark task as `{ id, status: "error", error: "[description]" }` in state.
5. Continue to the next task — never let one failure stop the whole run.
