// Slack Web API client (chat.postMessage)
// Used by a6 sync watchdog for health alerts.

const SLACK_API = "https://slack.com/api";

function token(): string {
  const t = process.env.SLACK_BOT_TOKEN;
  if (!t) throw new Error("SLACK_BOT_TOKEN is not set");
  return t;
}

/** Sends a plain-text alert to a Slack channel. */
export async function sendAlert(channel: string, text: string): Promise<void> {
  const res = await fetch(`${SLACK_API}/chat.postMessage`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel, text }),
  });
  if (!res.ok) throw new Error(`Slack API error: ${res.status}`);
  const data = (await res.json()) as { ok: boolean; error?: string };
  if (!data.ok) throw new Error(`Slack chat.postMessage failed: ${data.error}`);
}

/** Sends a rich block message. */
export async function sendBlockMessage(channel: string, blocks: unknown[]): Promise<void> {
  const res = await fetch(`${SLACK_API}/chat.postMessage`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel, blocks }),
  });
  if (!res.ok) throw new Error(`Slack API error: ${res.status}`);
  const data = (await res.json()) as { ok: boolean; error?: string };
  if (!data.ok) throw new Error(`Slack chat.postMessage (blocks) failed: ${data.error}`);
}
