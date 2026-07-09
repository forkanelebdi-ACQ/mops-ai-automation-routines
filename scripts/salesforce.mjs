#!/usr/bin/env node
// Salesforce API helper — called by Claude Code routines via Bash
// Usage: node scripts/salesforce.mjs <command> [--flag value ...]
// Commands: create-campaign, add-member-statuses, query-campaigns

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from project root
function loadEnv() {
  try {
    const envPath = join(__dirname, "..", ".env");
    const lines = readFileSync(envPath, "utf8").split("\n");
    for (const line of lines) {
      const [key, ...rest] = line.split("=");
      if (key && rest.length) process.env[key.trim()] = rest.join("=").trim();
    }
  } catch {}
}
loadEnv();

const SF_INSTANCE_URL  = process.env.SF_INSTANCE_URL  ?? "https://login.salesforce.com";
const SF_CLIENT_ID     = process.env.SF_CLIENT_ID     ?? "";
const SF_CLIENT_SECRET = process.env.SF_CLIENT_SECRET ?? "";
const SF_USERNAME      = process.env.SF_USERNAME      ?? "";
const SF_PASSWORD      = process.env.SF_PASSWORD      ?? "";
const SF_SECURITY_TOKEN = process.env.SF_SECURITY_TOKEN ?? "";
const SF_RECORD_TYPE_ID = process.env.SF_CAMPAIGN_RECORD_TYPE_ID ?? "TODO_SF_CAMPAIGN_RECORD_TYPE_ID";

const MEMBER_STATUSES = {
  Event:   ["Registered", "Attended", "No Show", "Walk-in", "Booth Visit"],
  Webinar: ["Registered", "Attended", "No Show", "On-Demand View"],
  Email:   ["Sent", "Opened", "Clicked", "Bounced", "Unsubscribed"],
  Paid:    ["Impression", "Clicked", "Form Fill", "Converted"],
  Content: ["Downloaded", "Viewed", "Engaged", "Converted"],
};

const RESPONDED_STATUSES = {
  Event:   ["Attended", "Walk-in", "Booth Visit"],
  Webinar: ["Attended", "On-Demand View"],
  Email:   ["Clicked"],
  Paid:    ["Form Fill", "Converted"],
  Content: ["Downloaded", "Engaged", "Converted"],
};

// --- Auth ---
let _token = null;
let _instanceUrl = null;

async function getToken() {
  if (_token) return { token: _token, instanceUrl: _instanceUrl };

  const body = new URLSearchParams({
    grant_type: "password",
    client_id: SF_CLIENT_ID,
    client_secret: SF_CLIENT_SECRET,
    username: SF_USERNAME,
    password: SF_PASSWORD + SF_SECURITY_TOKEN,
  });

  const res = await fetch(`${SF_INSTANCE_URL}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`SF auth failed: ${err}`);
  }

  const data = await res.json();
  _token = data.access_token;
  _instanceUrl = data.instance_url;
  return { token: _token, instanceUrl: _instanceUrl };
}

async function sfRequest(method, path, body) {
  const { token, instanceUrl } = await getToken();
  const res = await fetch(`${instanceUrl}/services/data/v59.0${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`SF ${method} ${path} failed (${res.status}): ${text}`);
  return text ? JSON.parse(text) : {};
}

// --- Commands ---

async function createCampaign(args) {
  const { name, type, region, "go-live": goLive, budget, owner } = args;

  const payload = {
    Name: name,
    Type: type,
    Region__c: region,          // TODO(ground-truth): verify custom field API name
    StartDate: goLive,
    Status: "Planned",
    BudgetedCost: budget ? parseFloat(budget) : undefined,
    OwnerId: owner,              // TODO(ground-truth): resolve owner name to SF User ID
    RecordTypeId: SF_RECORD_TYPE_ID,
  };

  // Remove undefined fields
  Object.keys(payload).forEach(k => payload[k] === undefined && delete payload[k]);

  const result = await sfRequest("POST", "/sobjects/Campaign", payload);
  return { sfCampaignId: result.id };
}

async function addMemberStatuses(args) {
  const { "campaign-id": campaignId, type } = args;
  const statuses = MEMBER_STATUSES[type] ?? [];
  const responded = new Set(RESPONDED_STATUSES[type] ?? []);

  for (const label of statuses) {
    await sfRequest("POST", "/sobjects/CampaignMemberStatus", {
      CampaignId: campaignId,
      Label: label,
      IsDefault: label === statuses[0],
      HasResponded: responded.has(label),
    });
  }

  return { ok: true, statusesAdded: statuses.length };
}

async function findCampaign(args) {
  const { name, id } = args;

  if (id) {
    try {
      const result = await sfRequest("GET", `/sobjects/Campaign/${id}?fields=Id,Name`);
      return { found: true, sfCampaignId: result.Id, name: result.Name };
    } catch {
      return { found: false };
    }
  }

  if (name) {
    const escaped = name.replace(/'/g, "\\'");
    const soql = encodeURIComponent(
      `SELECT Id, Name FROM Campaign WHERE Name = '${escaped}' LIMIT 1`
    );
    const result = await sfRequest("GET", `/query?q=${soql}`);
    if (result.records?.length > 0) {
      return { found: true, sfCampaignId: result.records[0].Id, name: result.records[0].Name };
    }
    return { found: false };
  }

  throw new Error("find-campaign requires --name or --id");
}

async function queryCampaigns() {
  const soql = encodeURIComponent(
    "SELECT Id, Name, NumberOfContacts, ConnectedCampaignId " +
    "FROM Campaign " +
    "WHERE IsActive = true AND ConnectedCampaignId != null " +
    "LIMIT 200"
    // TODO(ground-truth): confirm ConnectedCampaignId field name
  );

  const result = await sfRequest("GET", `/query?q=${soql}`);
  return (result.records ?? []).map(r => ({
    sfId: r.Id,
    name: r.Name,
    sfMemberCount: r.NumberOfContacts ?? 0,
    pardotCampaignId: r.ConnectedCampaignId ?? null,
  }));
}

// --- Arg parser ---
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      args[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return args;
}

// --- Main ---
const [,, command, ...rest] = process.argv;
const args = parseArgs(rest);

try {
  let result;
  if (command === "create-campaign")       result = await createCampaign(args);
  else if (command === "find-campaign")    result = await findCampaign(args);
  else if (command === "add-member-statuses") result = await addMemberStatuses(args);
  else if (command === "query-campaigns") result = await queryCampaigns();
  else throw new Error(`Unknown command: ${command}`);

  console.log(JSON.stringify(result));
  process.exit(0);
} catch (err) {
  console.log(JSON.stringify({ error: err.message }));
  process.exit(1);
}
