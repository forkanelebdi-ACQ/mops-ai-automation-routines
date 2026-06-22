// Salesforce REST API client (OAuth 2.0 username-password flow)
// Used exclusively by a2. All SF writes go through this module.

// TODO(ground-truth): Confirm SF_CAMPAIGN_RECORD_TYPE_ID via:
//   SF Setup → Object Manager → Campaign → Record Types → copy the 18-char ID
const SF_RECORD_TYPE_ID =
  process.env.SF_CAMPAIGN_RECORD_TYPE_ID ?? "TODO_SF_CAMPAIGN_RECORD_TYPE_ID";

// TODO(ground-truth): Verify these field API names in SF Setup → Object Manager → Campaign → Fields & Relationships
export const SF_FIELDS = {
  NAME:           "Name",
  TYPE:           "Type",
  STATUS:         "Status",
  START_DATE:     "StartDate",
  END_DATE:       "EndDate",
  BUDGET:         "BudgetedCost",   // TODO(ground-truth): may be ActualCost or a custom field
  PARENT_ID:      "ParentId",
  RECORD_TYPE_ID: "RecordTypeId",
  DESCRIPTION:    "Description",
  IS_ACTIVE:      "IsActive",
} as const;

// ---- types ----

export interface SfCampaignParams {
  name: string;
  type: string;       // matches CampaignType
  startDate: string;  // YYYY-MM-DD
  endDate?: string;
  budget?: number;
  parentId?: string;
  description?: string;
}

// ---- auth (simple token cache for the lifetime of the task run) ----

let _token: string | null = null;
let _instanceUrl: string | null = null;

async function getToken(): Promise<{ token: string; instanceUrl: string }> {
  if (_token && _instanceUrl) return { token: _token, instanceUrl: _instanceUrl };

  const body = new URLSearchParams({
    grant_type: "password",
    client_id:     process.env.SF_CLIENT_ID ?? "",
    client_secret: process.env.SF_CLIENT_SECRET ?? "",
    username:      process.env.SF_USERNAME ?? "",
    password:      `${process.env.SF_PASSWORD ?? ""}${process.env.SF_SECURITY_TOKEN ?? ""}`,
  });

  const loginUrl = process.env.SF_INSTANCE_URL ?? "https://login.salesforce.com";
  const res = await fetch(`${loginUrl}/services/oauth2/token`, {
    method: "POST",
    body,
  });
  if (!res.ok) {
    throw new Error(`Salesforce auth failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { access_token: string; instance_url: string };
  _token = data.access_token;
  _instanceUrl = data.instance_url;
  return { token: _token, instanceUrl: _instanceUrl };
}

async function sfPost<T>(path: string, payload: unknown): Promise<T> {
  const { token, instanceUrl } = await getToken();
  const res = await fetch(`${instanceUrl}/services/data/v59.0${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`SF POST ${path} → ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

// ---- public API ----

/** Creates a Salesforce Campaign and returns its 18-char ID. */
export async function createCampaign(params: SfCampaignParams): Promise<string> {
  const record: Record<string, unknown> = {
    [SF_FIELDS.NAME]:           params.name,
    [SF_FIELDS.TYPE]:           params.type,
    [SF_FIELDS.START_DATE]:     params.startDate,
    [SF_FIELDS.STATUS]:         "Planned",
    [SF_FIELDS.IS_ACTIVE]:      true,
    [SF_FIELDS.RECORD_TYPE_ID]: SF_RECORD_TYPE_ID,
  };
  if (params.endDate)     record[SF_FIELDS.END_DATE]   = params.endDate;
  if (params.budget)      record[SF_FIELDS.BUDGET]      = params.budget;
  if (params.parentId)    record[SF_FIELDS.PARENT_ID]   = params.parentId;
  if (params.description) record[SF_FIELDS.DESCRIPTION] = params.description;

  const result = await sfPost<{ id: string; success: boolean; errors: unknown[] }>(
    "/sobjects/Campaign",
    record
  );
  if (!result.success) {
    throw new Error(`SF Campaign creation failed for "${params.name}": ${JSON.stringify(result.errors)}`);
  }
  return result.id;
}

/**
 * Adds the correct CampaignMemberStatus records for the given campaign type.
 * The first status in the array is set as the default.
 * TODO(ground-truth): Verify whether the org uses standard or custom CampaignMemberStatus; SF may
 *   require deleting the two default statuses (Sent, Responded) before adding type-specific ones.
 */
export async function addMemberStatuses(
  campaignId: string,
  statuses: string[],
  respondedStatuses: string[]
): Promise<void> {
  for (const [i, label] of statuses.entries()) {
    await sfPost("/sobjects/CampaignMemberStatus", {
      CampaignId:    campaignId,
      Label:         label,
      IsDefault:     i === 0,
      HasResponded:  respondedStatuses.includes(label),
    });
  }
}
