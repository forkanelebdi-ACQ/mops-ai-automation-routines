// Airtable REST API client — audit log for every AI decision (§10).
// Every task must call logDecision() so the MOps team can audit what the system did and why.

const AIRTABLE_API = "https://api.airtable.com/v0";

// TODO(ground-truth): Copy BASE_ID from the Airtable URL: airtable.com/appXXXXXXXXXXXXXX/...
const BASE_ID = process.env.AIRTABLE_BASE_ID ?? "TODO_AIRTABLE_BASE_ID";

// TODO(ground-truth): Use the Airtable table name or table ID for the audit log table
const AUDIT_TABLE = process.env.AIRTABLE_AUDIT_TABLE_ID ?? "Audit Log";

export interface AuditEntry {
  taskId: string;
  automation: string;
  decision: string;
  confidence?: number;
  model?: string;
  timestamp: string;
  data?: Record<string, unknown>;
}

function authHeaders(): Record<string, string> {
  const key = process.env.AIRTABLE_API_KEY;
  if (!key) throw new Error("AIRTABLE_API_KEY is not set");
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

/** Writes an AI decision record to the Airtable audit log. */
export async function logDecision(asanaTaskId: string, entry: AuditEntry): Promise<void> {
  const res = await fetch(
    `${AIRTABLE_API}/${BASE_ID}/${encodeURIComponent(AUDIT_TABLE)}`,
    {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        fields: {
          "Asana Task ID": asanaTaskId,
          Automation:      entry.automation,
          Decision:        entry.decision,
          Confidence:      entry.confidence,
          Model:           entry.model,
          Timestamp:       entry.timestamp,
          Data:            entry.data ? JSON.stringify(entry.data) : undefined,
        },
      }),
    }
  );
  if (!res.ok) {
    throw new Error(`Airtable log failed: ${res.status} ${await res.text()}`);
  }
}
