# MOps AI Automation — Manager Brief

## The Problem

Every time a campaign is requested, someone on the MOps team manually reads the Asana intake form and re-types the same information into Salesforce, sets up Pardot, creates an asset checklist in Asana, and writes a campaign brief. This process:

- Takes **75–115 minutes per campaign**
- Is error-prone (naming convention violations, missing member statuses)
- Silently breaks the Pardot–Salesforce sync without anyone noticing
- Scales poorly as campaign volume grows

At 20 campaigns per month, that is approximately **30 hours of manual admin work** — nearly one full work week — spent on data re-entry.

---

## The Solution

An AI automation system that handles the entire campaign intake process automatically, from the moment a form is submitted to a fully built Salesforce campaign with all required setup complete.

The system runs as a **scheduled AI agent** (Claude Code routine) — no dedicated server required. A human is only involved when the AI is uncertain or when a campaign name needs correction. Everything else runs without anyone touching it.

---

## What It Does Automatically

**Every hour, the agent checks for new Asana submissions and:**

1. Reads the intake form and classifies the campaign using AI
2. Validates the campaign name against the naming convention
3. Creates the Salesforce campaign with the correct type, region, dates, and budget
4. Sets up all required member statuses in Salesforce
5. Creates the Pardot connected campaign and links it to Salesforce
6. Builds an asset checklist in Asana (one subtask per deliverable)
7. Writes a one-page campaign brief and posts it to the Asana task

**Every day at 9am:**

8. Checks that Pardot and Salesforce member counts match across all active campaigns and alerts the team on Slack if anything is out of sync

---

## Time Savings

| | Manual | Automated |
|---|---|---|
| Time per campaign | ~90 minutes | ~2 minutes |
| Monthly (20 campaigns) | ~30 hours | ~40 minutes |
| **Hours saved per month** | | **~29 hours** |

---

## When a Human Is Still Needed

The system is designed to involve a human only when necessary:

| Situation | What happens |
|-----------|-------------|
| AI confidence is low (unclear intake) | System flags for human review and stops. No Salesforce record is created. |
| Campaign name fails validation | System suggests a corrected name, posts it to Asana, and waits for the regional owner to approve before continuing. |
| Pardot–Salesforce sync diverges | Slack alert is sent to the MOps channel. |
| Same campaign diverges 3+ days in a row | Escalation alert sent — manual investigation required. |

In all other cases — the majority — the pipeline runs fully automatically.

---

## Self-Correcting Design

The agent doesn't just follow a fixed script. When something goes wrong, it reasons about the error and tries to fix it:

- If a Salesforce field fails validation → reads the error, adjusts the value, retries
- If its own campaign name suggestion is invalid → fixes it before posting to Asana
- If classification is ambiguous → re-reads the intake with more context before flagging for human review

This reduces unnecessary human escalations and improves accuracy over time as the agent learns from past campaigns.

---

## Who Owns What

Campaigns are automatically assigned to the regional owner based on the campaign's target geography:

| Region | Owner |
|--------|-------|
| Americas (AMER) | Harish |
| Europe, Middle East & Africa (EMEA) | Aayushi |
| Asia Pacific & Japan (APJ) | Aayushi |
| Latin America (LATAM) | Felipe |

---

## Systems Involved

| System | Role |
|--------|------|
| **Asana** | Source of truth for intake forms, subtasks, and comments |
| **Salesforce** | Campaign records and member status management |
| **Pardot / Account Engagement** | Connected campaign creation and sync monitoring |
| **Slack** | Alerts for sync issues and escalations |
| **Google Sheets** | Audit trail — every AI decision is logged per campaign |
| **Claude AI (Sonnet 4.6)** | Classification, naming correction, brief drafting, self-correction |
| **Claude Code Routines** | Scheduling infrastructure — no dedicated server required |

---

## Current Status

The full automation pipeline is built and running as scheduled cloud routines. The agent processes Asana submissions every hour and runs the sync watchdog daily at 9am UTC.

**Before going live on the real intake project, the following org-specific values need to be confirmed:**

- Asana intake project ID
- Salesforce Campaign Record Type ID
- Pardot Business Unit ID
- Google Sheets spreadsheet ID and audit sheet tab name
- Slack alert channel ID

Once these are filled in, the agent will begin processing real campaign submissions automatically.

---

## Risk and Controls

| Risk | Control |
|------|---------|
| Bad data entering Salesforce | Naming gate blocks record creation if the name is not approved |
| Low-confidence AI classification | Confidence threshold (70%) — below this, a human must review |
| Pardot–SF drift going unnoticed | Daily automated sync check with Slack alerts |
| Accidental duplicate campaigns | State file tracks every processed task ID — duplicates are skipped |
| Secrets exposure | All credentials are environment variables — none are in the codebase |
| Agent making uncorrectable errors | Error logged to Asana + Slack, task marked for review, pipeline continues to next task |

---

## Bottom Line

This system eliminates the most repetitive part of campaign operations — the manual re-keying of intake data across four platforms — and replaces it with an AI agent that runs in under 2 minutes, self-corrects its own mistakes, and improves over time. The team's time is redirected from data entry to work that actually requires human judgment.
