#!/usr/bin/env node
// Google Sheets helper — audit logging and similar campaign lookup
// Uses Google Sheets API v4 with a service account (no npm dependencies)
//
// Usage:
//   node scripts/sheets.mjs log --task-id "..." --automation "..." --decision "..." --type "..." --region "..." --sf-campaign-id "..."
//   node scripts/sheets.mjs get-similar --limit 3
//
// Required env vars:
//   GOOGLE_SERVICE_ACCOUNT_EMAIL   — service account email (e.g. mops-bot@project.iam.gserviceaccount.com)
//   GOOGLE_SERVICE_ACCOUNT_KEY     — RSA private key PEM; replace literal \n with actual newlines
//   GOOGLE_SHEETS_SPREADSHEET_ID   — ID from the sheet URL (between /d/ and /edit)
//   GOOGLE_SHEETS_AUDIT_SHEET      — sheet tab name (default: "AuditLog")
//
// Sheet column layout (A–G):
//   A: AsanaTaskId  B: Automation  C: Decision  D: Type  E: Region  F: SFCampaignId  G: Timestamp

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createSign } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));

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

const SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ?? "";
const SERVICE_ACCOUNT_KEY   = (process.env.GOOGLE_SERVICE_ACCOUNT_KEY ?? "").replace(/\\n/g, "\n");
const SPREADSHEET_ID        = process.env.GOOGLE_SHEETS_SPREADSHEET_ID ?? "";
const AUDIT_SHEET           = process.env.GOOGLE_SHEETS_AUDIT_SHEET ?? "AuditLog";

let _token = null;
let _tokenExpiry = 0;

async function getAccessToken() {
  if (_token && Date.now() < _tokenExpiry) return _token;
  if (!SERVICE_ACCOUNT_EMAIL) throw new Error("GOOGLE_SERVICE_ACCOUNT_EMAIL is not set");
  if (!SERVICE_ACCOUNT_KEY)   throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY is not set");

  const now     = Math.floor(Date.now() / 1000);
  const header  = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss:   SERVICE_ACCOUNT_EMAIL,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud:   "https://oauth2.googleapis.com/token",
    exp:   now + 3600,
    iat:   now,
  })).toString("base64url");

  const sign = createSign("RSA-SHA256");
  sign.update(`${header}.${payload}`);
  const jwt = `${header}.${payload}.${sign.sign(SERVICE_ACCOUNT_KEY, "base64url")}`;

  const res  = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion:  jwt,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Token exchange failed: ${JSON.stringify(data)}`);

  _token       = data.access_token;
  _tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return _token;
}

async function sheetsGet(range) {
  const token = await getAccessToken();
  const url   = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(range)}`;
  const res   = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const text  = await res.text();
  if (!res.ok) throw new Error(`Sheets GET failed (${res.status}): ${text}`);
  return JSON.parse(text);
}

async function sheetsAppend(range, rows) {
  const token = await getAccessToken();
  const url   = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW`;
  const res   = await fetch(url, {
    method:  "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body:    JSON.stringify({ range, majorDimension: "ROWS", values: rows }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Sheets append failed (${res.status}): ${text}`);
  return JSON.parse(text);
}

async function logDecision(args) {
  if (!SPREADSHEET_ID) throw new Error("GOOGLE_SHEETS_SPREADSHEET_ID is not set");
  const row = [
    args["task-id"]        ?? "",
    args["automation"]     ?? "",
    args["decision"]       ?? "",
    args["type"]           ?? "",
    args["region"]         ?? "",
    args["sf-campaign-id"] ?? "",
    new Date().toISOString(),
  ];
  await sheetsAppend(`${AUDIT_SHEET}!A:G`, [row]);
  return { ok: true };
}

async function getSimilar(args) {
  if (!SPREADSHEET_ID) throw new Error("GOOGLE_SHEETS_SPREADSHEET_ID is not set");
  const limit  = parseInt(args.limit ?? "3", 10);
  const result = await sheetsGet(`${AUDIT_SHEET}!A:G`);
  const rows   = (result.values ?? []).slice(1); // skip header row
  const completed = rows
    .filter(r => r[2] === "completed")
    .slice(-limit);
  return completed.map(r => ({
    AsanaTaskId:  r[0] ?? "",
    Automation:   r[1] ?? "",
    Decision:     r[2] ?? "",
    Type:         r[3] ?? "",
    Region:       r[4] ?? "",
    SFCampaignId: r[5] ?? "",
    Timestamp:    r[6] ?? "",
  }));
}

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

const [,, command, ...rest] = process.argv;
const args = parseArgs(rest);

try {
  let result;
  if      (command === "log")          result = await logDecision(args);
  else if (command === "get-similar")  result = await getSimilar(args);
  else throw new Error(`Unknown command: ${command}`);

  console.log(JSON.stringify(result));
  process.exit(0);
} catch (err) {
  console.log(JSON.stringify({ error: err.message }));
  process.exit(1);
}
