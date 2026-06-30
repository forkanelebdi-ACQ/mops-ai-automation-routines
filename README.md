# MOps AI Automation

An AI agent pipeline that automates Marketing Operations campaign intake — from an Asana form submission to a fully built Salesforce campaign with asset checklist and campaign brief — powered by Claude Code routines and the Asana MCP.

---

## What it does

Every hour, a Claude Code cloud routine polls the Asana intake project. For each new submission it runs a sequential pipeline:

| Step | Stage | What happens |
|------|-------|-------------|
| 1 | **a1 — Intake Triage** | Claude classifies the campaign (type, region, quarter, owner). Stops if confidence < 70%. |
| 2 | **a5 — Naming Enforcer** | Validates the campaign name against the `[Year]_[Region]_[Type]_[Name]_[Quarter]` convention. Blocks a2 if invalid. Posts suggested correction to Asana for human approval. |
| 3 | **a2 — SF Campaign Build** | Creates the Salesforce campaign, adds member statuses, creates the Pardot connected campaign. |
| 4 | **a3 — Asset Checklist** | Creates one Asana subtask per required asset based on campaign type. |
| 5 | **a4 — Brief Drafting** | Claude writes a one-page campaign brief and posts it as an Asana comment. |

A separate daily routine (**a6 — Sync Watchdog**) compares Pardot vs Salesforce member counts and Slack-alerts on divergence.

---

## How it runs

This project uses **Claude Code cloud routines** — scheduled AI agents that run in Anthropic's cloud. No server to manage, no deployment pipeline. The agent:

- Clones this repo on each run
- Reads `routines/intake-pipeline.md` for instructions
- Uses the **Asana MCP** for all Asana operations (authenticated automatically)
- Runs `scripts/*.mjs` for Salesforce, Pardot, Slack, and Google Sheets operations

### Self-correcting behavior

Unlike a fixed script, the agent reasons about errors and retries with corrected parameters. If a Salesforce field fails validation, the agent reads the error, adjusts the value, and retries. If classification is ambiguous, it re-reads the task with more context before flagging for human review.

---

## Tech stack

- **[Claude Code Routines](https://claude.ai/code/routines)** — scheduled cloud agents, hourly intake + daily watchdog
- **[Asana MCP](https://mcp.asana.com)** — native Asana integration (read tasks, add comments, create subtasks)
- **Claude AI (Sonnet 4.6)** — classification, naming correction, brief drafting, self-correction
- **Node.js ESM scripts** — lightweight API helpers for Salesforce, Pardot, Slack, Google Sheets (no npm dependencies)

### Integrations
- Asana (intake form, subtasks, comments) — via MCP
- Salesforce (campaign + member statuses) — via `scripts/salesforce.mjs`
- Pardot / Account Engagement (connected campaigns) — via `scripts/pardot.mjs`
- Slack (alerts and weekly health report) — via `scripts/slack.mjs`
- Google Sheets (AI decision audit trail) — via `scripts/sheets.mjs`

---

## Project structure

```
routines/
├── intake-pipeline.md    # Agent instructions — what Claude does on each hourly run
└── sync-watchdog.md      # Agent instructions — daily Pardot/SF sync check

scripts/
├── salesforce.mjs        # SF OAuth + campaign creation + member statuses
├── pardot.mjs            # Pardot connected campaign creation
├── slack.mjs             # Slack alert sender
└── sheets.mjs            # Google Sheets audit log + similar campaign lookup

src/config/
├── naming-rules.ts       # Naming convention regex, validator, builder
├── routing.ts            # Region → owner mapping, confidence floor
├── member-statuses.ts    # Per-type SF member status lists
└── asset-checklists.ts   # Per-type Asana subtask lists

state/
└── processed-tasks.json  # Tracks processed Asana task IDs (idempotency)
```

---

## Getting started

### Prerequisites
- Node.js 18+ (for running scripts locally)
- A [claude.ai](https://claude.ai) account with Claude Code access
- Asana MCP connected at [claude.ai/customize/connectors](https://claude.ai/customize/connectors)

### Clone and configure

```bash
git clone https://github.com/flebdi/mops-ai-automation.git
cd mops-ai-automation
cp .env.example .env
```

Fill in `.env` with your credentials. See the [Environment variables](#environment-variables) section below.

### Test a script locally

```bash
node scripts/salesforce.mjs create-campaign \
  --name "2026_EMEA_Webinar_Test_Q3" \
  --type "Webinar" \
  --region "EMEA" \
  --go-live "2026-09-01" \
  --owner "Aayushi"
```

### View or manage routines

The two live routines are at:
- Intake pipeline (hourly): https://claude.ai/code/routines/trig_01AoVLQMUh9X1K1aR7Phsd8a
- Sync watchdog (daily 9am UTC): https://claude.ai/code/routines/trig_013JndXKye2ntDeVyEXHYmh7

---

## Environment variables

| Variable | Where to get it |
|----------|----------------|
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) |
| `ASANA_ACCESS_TOKEN` | Asana → My Profile → Apps → Personal access tokens |
| `ASANA_WORKSPACE_GID` | Asana URL: `app.asana.com/0/{workspace_gid}` |
| `ASANA_INTAKE_PROJECT_GID` | Asana URL of your intake form project |
| `SF_INSTANCE_URL` | Your Salesforce org URL |
| `SF_CLIENT_ID` / `SF_CLIENT_SECRET` | SF Setup → App Manager → Connected App |
| `SF_USERNAME` / `SF_PASSWORD` / `SF_SECURITY_TOKEN` | Your SF user credentials |
| `SF_CAMPAIGN_RECORD_TYPE_ID` | SF Setup → Object Manager → Campaign → Record Types |
| `PARDOT_BUSINESS_UNIT_ID` | Account Engagement → Settings → Business Unit Setup |
| `SLACK_BOT_TOKEN` | [api.slack.com/apps](https://api.slack.com/apps) → Your app → OAuth tokens |
| `SLACK_ALERT_CHANNEL` | Slack channel ID (right-click channel → Copy link) |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Google Cloud → IAM → Service Accounts |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Service account → Keys → Add Key → JSON (copy the `private_key` field) |
| `GOOGLE_SHEETS_SPREADSHEET_ID` | Google Sheets URL — the ID between `/d/` and `/edit` |
| `GOOGLE_SHEETS_AUDIT_SHEET` | Name of the sheet tab for the audit log (e.g. `AuditLog`) |

---

## Campaign naming convention

All campaigns must follow this exact format:

```
[Year]_[Region]_[Type]_[CampaignName]_[Quarter]
```

**Example:** `2026_EMEA_Webinar_DrupalSecurity_Q3`

| Segment | Valid values |
|---------|-------------|
| Year | 4-digit year (e.g. `2026`) |
| Region | `AMER`, `EMEA`, `APJ`, `LATAM` |
| Type | `Event`, `Webinar`, `Email`, `Paid`, `Content` |
| CampaignName | PascalCase, no spaces or special characters |
| Quarter | `Q1`, `Q2`, `Q3`, `Q4` |

If the name doesn't match, the agent auto-corrects it, validates its own suggestion, then posts it to Asana for the regional owner to approve before continuing.

---

## Regional ownership

| Region | Owner |
|--------|-------|
| AMER | Harish |
| EMEA | Aayushi |
| APJ | Aayushi |
| LATAM | Felipe |

---

## Ground-truth TODOs

Before going live, confirm these values from your org:

| # | Value | File | Where to find it |
|---|-------|------|-----------------|
| 1 | `ASANA_INTAKE_PROJECT_GID` | `.env` | Asana intake project URL |
| 2 | `SF_CAMPAIGN_RECORD_TYPE_ID` | `.env` | SF Setup → Campaign → Record Types |
| 3 | `SF_FIELDS.BUDGET` | `scripts/salesforce.mjs` | Verify `BudgetedCost` field API name |
| 4 | `PARDOT_BUSINESS_UNIT_ID` | `.env` | Account Engagement → Settings |
| 5 | `GOOGLE_SHEETS_SPREADSHEET_ID` | `.env` | Google Sheets URL — the ID between `/d/` and `/edit` |
| 6 | `SLACK_ALERT_CHANNEL` | `.env` | Slack channel ID |
| 7 | Pardot member count field | `scripts/pardot.mjs` | Pardot API v5 docs |

---

## License

MIT
