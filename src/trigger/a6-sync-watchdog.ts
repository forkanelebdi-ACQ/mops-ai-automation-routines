// a6: Sync Watchdog — scheduled, NOT in the per-ticket pipeline
// Daily 09:00 UTC: compares Pardot vs SF member counts; Slack-alerts if diverged > 2 h.
// Monday 08:00 UTC: weekly health report (use the daily task + day-of-week check).
//
// TODO(ground-truth): Needs live SF + Pardot credentials before this can do real work.
// The daily task runs on the `0 9 * * *` cron; the weekly report is gated inside by
// checking new Date().getUTCDay() === 1 (Monday).

import { schedules } from "@trigger.dev/sdk";
import { sendAlert } from "../lib/slack.js";

// TODO(ground-truth): Confirm the SF SOQL query returns the right fields once credentials are live.
// Specifically: the field that stores the Pardot Connected Campaign ID (often "ConnectedCampaignId"
// or a custom field — check SF Setup → Object Manager → Campaign → Fields).
const SF_PARDOT_CAMPAIGN_ID_FIELD = "ConnectedCampaignId"; // TODO(ground-truth): verify

// TODO(ground-truth): Confirm the Pardot API v5 endpoint for reading prospect/member counts.
// The path below is a best guess — verify against Account Engagement API docs.
const PARDOT_STATS_PATH = "/api/v5/objects/campaigns/{id}/stats"; // TODO(ground-truth): verify

// Sync is flagged as broken if the member-count delta has persisted longer than this.
const SYNC_BROKEN_THRESHOLD_HOURS = 2;

interface SfCampaign {
  Id: string;
  Name: string;
  NumberOfContacts: number;
  ConnectedCampaignId?: string; // TODO(ground-truth): use correct field name
}

interface SyncFinding {
  sfId: string;
  name: string;
  sfCount: number;
  pardotCount: number;
  delta: number;
}

async function querySfCampaigns(): Promise<SfCampaign[]> {
  // TODO(ground-truth): Implement using lib/salesforce.ts once getSfToken() is wired.
  // SOQL: SELECT Id, Name, NumberOfContacts, ${SF_PARDOT_CAMPAIGN_ID_FIELD}
  //       FROM Campaign
  //       WHERE IsActive = true
  //         AND ${SF_PARDOT_CAMPAIGN_ID_FIELD} != null
  void SF_PARDOT_CAMPAIGN_ID_FIELD;
  return []; // stub
}

async function getPardotMemberCount(_pardotCampaignId: string): Promise<number> {
  // TODO(ground-truth): Implement via Pardot API v5.
  // GET /api/v5/objects/campaigns/{id} with Pardot-Business-Unit-Id header.
  // The field for prospect/member count may be "totalProspects" or similar.
  void PARDOT_STATS_PATH;
  return 0; // stub
}

export const syncWatchdog = schedules.task({
  id: "a6-sync-watchdog",
  cron: "0 9 * * *", // daily 09:00 UTC

  run: async () => {
    const slackChannel = process.env.SLACK_ALERT_CHANNEL;
    if (!slackChannel) throw new Error("SLACK_ALERT_CHANNEL is not set");

    const campaigns = await querySfCampaigns();

    const findings: SyncFinding[] = [];
    const orphans: string[] = [];

    for (const campaign of campaigns) {
      const pardotId = campaign.ConnectedCampaignId; // TODO(ground-truth): update field name
      if (!pardotId) {
        orphans.push(campaign.Id);
        continue;
      }

      const pardotCount = await getPardotMemberCount(pardotId);
      const sfCount = campaign.NumberOfContacts ?? 0;
      const delta = Math.abs(sfCount - pardotCount);

      // Flag any non-zero delta — downstream the threshold check would compare timestamps
      // to confirm it's been broken > SYNC_BROKEN_THRESHOLD_HOURS
      if (delta > 0) {
        findings.push({ sfId: campaign.Id, name: campaign.Name, sfCount, pardotCount, delta });
      }
    }

    // Alert for each diverged campaign
    for (const f of findings) {
      await sendAlert(
        slackChannel,
        `⚠️ Pardot–SF sync divergence detected on "${f.name}" (${f.sfId})\n` +
          `SF members: ${f.sfCount} | Pardot members: ${f.pardotCount} | Delta: ${f.delta}\n` +
          `Threshold: ${SYNC_BROKEN_THRESHOLD_HOURS}h — investigate and re-sync if needed.`
      );
    }

    // Alert for orphaned Pardot assets
    if (orphans.length > 0) {
      await sendAlert(
        slackChannel,
        `⚠️ ${orphans.length} SF campaign(s) are missing a Pardot connected campaign: ${orphans.join(", ")}`
      );
    }

    // Weekly health report on Mondays
    const isMonday = new Date().getUTCDay() === 1;
    if (isMonday) {
      const reportLines = [
        `📊 *MOps Weekly Sync Health Report*`,
        `Campaigns checked: ${campaigns.length}`,
        `Diverged: ${findings.length}`,
        `Orphaned (no Pardot campaign): ${orphans.length}`,
        findings.length === 0 && orphans.length === 0
          ? "✅ All campaigns in sync."
          : `❌ Issues found — see daily alerts above for details.`,
      ];
      await sendAlert(slackChannel, reportLines.join("\n"));
    }

    return { findings: findings.length, orphans: orphans.length, campaignsChecked: campaigns.length };
  },
});
