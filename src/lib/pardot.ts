// Pardot / Account Engagement API v5 client
// Used by a2 to create the connected campaign after the SF campaign exists.

// TODO(ground-truth): Find PARDOT_BUSINESS_UNIT_ID in Account Engagement:
//   Account Engagement → Settings → Account Settings → Business Unit Setup
//   It is an 18-character ID starting with "0Uv"
const BUSINESS_UNIT_ID =
  process.env.PARDOT_BUSINESS_UNIT_ID ?? "TODO_PARDOT_BUSINESS_UNIT_ID";

let _token: string | null = null;

async function getToken(): Promise<string> {
  if (_token) return _token;

  // Pardot uses a Salesforce OAuth token with scope=pardot_api
  const body = new URLSearchParams({
    grant_type:    "password",
    client_id:     process.env.PARDOT_CLIENT_ID ?? process.env.SF_CLIENT_ID ?? "",
    client_secret: process.env.PARDOT_CLIENT_SECRET ?? process.env.SF_CLIENT_SECRET ?? "",
    username:      process.env.SF_USERNAME ?? "",
    password:      `${process.env.SF_PASSWORD ?? ""}${process.env.SF_SECURITY_TOKEN ?? ""}`,
  });

  const res = await fetch("https://login.salesforce.com/services/oauth2/token", {
    method: "POST",
    body,
  });
  if (!res.ok) {
    throw new Error(`Pardot auth failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { access_token: string };
  _token = data.access_token;
  return _token;
}

/**
 * Creates a Pardot Connected Campaign linked to the given Salesforce Campaign.
 * Returns the Pardot campaign ID.
 * TODO(ground-truth): Confirm the exact request body shape against the Pardot API v5 docs
 *   (the salesforceCampaignId field name may differ — check the campaign object schema).
 */
export async function createConnectedCampaign(
  sfCampaignId: string,
  name: string
): Promise<string> {
  const token = await getToken();

  const res = await fetch("https://pi.pardot.com/api/v5/objects/campaigns", {
    method: "POST",
    headers: {
      Authorization:             `Bearer ${token}`,
      "Pardot-Business-Unit-Id": BUSINESS_UNIT_ID,
      "Content-Type":            "application/json",
    },
    body: JSON.stringify({
      name,
      salesforceCampaignId: sfCampaignId,
    }),
  });

  if (!res.ok) {
    throw new Error(`Pardot campaign creation failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { id: string };
  return data.id;
}
