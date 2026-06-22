// Asana REST API v1 client (PAT auth)
// All writes go through this module — never inline fetch in tasks.

const BASE = "https://app.asana.com/api/1.0";

// TODO(ground-truth): Set ASANA_INTAKE_PROJECT_GID to the GID from the intake form project URL
const INTAKE_PROJECT_GID =
  process.env.ASANA_INTAKE_PROJECT_GID ?? "TODO_ASANA_INTAKE_PROJECT_GID";

// TODO(ground-truth): Replace each placeholder with the real GID from:
//   GET /projects/{INTAKE_PROJECT_GID}/custom_field_settings
//   (run with your PAT to enumerate every field's gid and name)
export const FIELD_GIDS = {
  CAMPAIGN_NAME:      "TODO_FIELD_GID_CAMPAIGN_NAME",
  CAMPAIGN_TYPE:      "TODO_FIELD_GID_CAMPAIGN_TYPE",
  REGION:             "TODO_FIELD_GID_REGION",
  GO_LIVE_DATE:       "TODO_FIELD_GID_GO_LIVE_DATE",
  BUDGET:             "TODO_FIELD_GID_BUDGET",
  GOAL:               "TODO_FIELD_GID_GOAL",
  AUDIENCE:           "TODO_FIELD_GID_AUDIENCE",
  KEY_MESSAGE:        "TODO_FIELD_GID_KEY_MESSAGE",
  PARENT_PROGRAM_ID:  "TODO_FIELD_GID_PARENT_PROGRAM",
} as const;

// ---- types ----

export interface AsanaCustomField {
  gid: string;
  name: string;
  text_value?: string | null;
  display_value?: string | null;
  enum_value?: { name: string } | null;
  date_value?: { date: string } | null;
}

export interface AsanaTask {
  gid: string;
  name: string;
  created_at: string;
  custom_fields?: AsanaCustomField[];
}

export interface AsanaSubmission {
  id: string;
  name: string;
  fields: Record<string, string>;
  createdAt: string;
}

// ---- internals ----

function headers(): Record<string, string> {
  const token = process.env.ASANA_ACCESS_TOKEN;
  if (!token) throw new Error("ASANA_ACCESS_TOKEN is not set");
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: headers() });
  if (!res.ok) {
    throw new Error(`Asana GET ${path} → ${res.status}: ${await res.text()}`);
  }
  return ((await res.json()) as { data: T }).data;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ data: body }),
  });
  if (!res.ok) {
    throw new Error(`Asana POST ${path} → ${res.status}: ${await res.text()}`);
  }
  return ((await res.json()) as { data: T }).data;
}

async function put(path: string, body: unknown): Promise<void> {
  const res = await fetch(`${BASE}${path}`, {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify({ data: body }),
  });
  if (!res.ok) {
    throw new Error(`Asana PUT ${path} → ${res.status}: ${await res.text()}`);
  }
}

function flattenFields(task: AsanaTask): Record<string, string> {
  const out: Record<string, string> = { task_name: task.name };
  for (const cf of task.custom_fields ?? []) {
    const value =
      cf.text_value ??
      cf.enum_value?.name ??
      cf.date_value?.date ??
      cf.display_value ??
      "";
    if (value !== null) {
      out[cf.gid] = value;
      out[cf.name] = value; // also index by human name for prompt building
    }
  }
  return out;
}

// ---- public API ----

/**
 * Returns all tasks in the intake project.
 * The poller compares against a stored cursor to find new ones — or uses Asana's
 * modified_since parameter once real field GIDs are in place.
 */
export async function fetchNewSubmissions(): Promise<AsanaSubmission[]> {
  const tasks = await get<AsanaTask[]>(
    `/projects/${INTAKE_PROJECT_GID}/tasks?opt_fields=gid,name,created_at,custom_fields`
  );
  return tasks.map((t) => ({
    id: t.gid,
    name: t.name,
    fields: flattenFields(t),
    createdAt: t.created_at,
  }));
}

/** Fetches a single task by GID (used by a1 to get the full field set). */
export async function fetchTask(taskId: string): Promise<AsanaSubmission> {
  const t = await get<AsanaTask>(
    `/tasks/${taskId}?opt_fields=gid,name,created_at,custom_fields`
  );
  return { id: t.gid, name: t.name, fields: flattenFields(t), createdAt: t.created_at };
}

/** Adds a comment (story) to an Asana task. */
export async function addTaskComment(taskId: string, text: string): Promise<void> {
  await post<unknown>(`/tasks/${taskId}/stories`, { text });
}

/** Creates an Asana subtask under parentTaskId and returns the new task's GID. */
export async function createSubtask(parentTaskId: string, name: string): Promise<string> {
  const sub = await post<{ gid: string }>(`/tasks/${parentTaskId}/subtasks`, { name });
  return sub.gid;
}

/** Updates a single custom field on a task. */
export async function updateCustomField(
  taskId: string,
  fieldGid: string,
  value: string
): Promise<void> {
  await put(`/tasks/${taskId}`, { custom_fields: { [fieldGid]: value } });
}
