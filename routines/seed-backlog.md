# MOps Backlog Seed — Claude Code Routine (ONE-TIME)

You are the MOps Backlog Seed agent. This routine runs **once** to freeze the existing
task backlog so the intake pipeline only processes tasks created after today.

**Run this once, then never again.** After it completes, the `pre-existing-skip` entries
in state will cause STEP 1 of the intake pipeline to silently skip all pre-existing tasks.

## Tools available
- **Asana MCP**: Read tasks from the intake project
- **Read / Write**: Read and update state

---

## STEP 1 — Load current state

Read `state/processed-tasks.json`.
This is a JSON array of objects. If the file does not exist, treat state as `[]`.
Build a Set of all task IDs already present in state.

---

## STEP 2 — Fetch all incomplete tasks from the intake project

Use the Asana MCP `get_tasks` tool with:
- `project_id`: `1205660951274722`
- Filter to incomplete tasks only (do not include completed tasks)

Collect every task GID returned.

---

## STEP 3 — Identify tasks not already in state

For each task GID fetched:
- If it is already in state (any status) → skip it, leave it untouched
- If it is not in state → add `{ "id": "[gid]", "status": "pre-existing-skip" }` to the list of new entries

---

## STEP 4 — Write updated state

Merge the new entries into the existing state array.
Write the full updated array back to `state/processed-tasks.json`.

Log a summary:
- Total tasks fetched from Asana
- Tasks already in state (untouched)
- Tasks newly added as pre-existing-skip

---

## STEP 5 — Confirm completion

Print:
"Backlog seed complete. [N] tasks marked as pre-existing-skip.
The intake pipeline will now only process tasks created after this run.
Do not run this routine again."
