# A6 Spike: Cowork per-message hook feasibility

**Purpose:** determine whether Claude reliably invokes a "passive observer" MCP tool at the start of every turn in a Cowork (or Claude Desktop) session. If yes → Phase 6 signal-detector ships as designed. If no → reshape Phase 6 to session-start digest or user-explicit patterns.

**Why this matters:** Phase 6 assumes a skill can "read every message and suggest `/dent-append-evidence` when Dent-related work is happening." That pattern doesn't exist as a skill primitive in Cowork. The closest feasible mechanism is an MCP tool with an instruction-rich description that makes Claude call it at the start of every turn. This spike tests whether that works reliably enough to ship.

## How to run

### 1. Install dependencies

```bash
cd ~/gh/dent-brain/experiments/a6-cowork-hook-spike
npm install          # or: bun install
```

### 2. Wire into Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`. Add this inside the existing `"mcpServers"` block (alongside `filemaker` and any others):

```json
"a6-spike": {
  "command": "node",
  "args": ["/Users/jasonpreston/gh/dent-brain/experiments/a6-cowork-hook-spike/server.js"]
}
```

Validate the JSON:

```bash
python3 -m json.tool ~/Library/Application\ Support/Claude/claude_desktop_config.json > /dev/null && echo "VALID"
```

Fully quit Claude Desktop (⌘Q) and reopen. In a new chat, ask Claude: "What tools do you have?" — you should see `passive_observer` in the list.

### 3. Run the test

Open a **Cowork session** (shared chat) — not a solo chat. This is specifically testing Cowork's behavior.

Have a conversation of 8-10 exchanges with varied topics, e.g.:

1. "What's the weather like typically in Seattle in April?"
2. "Can you summarize the key tradeoffs between REST and GraphQL?"
3. "Who are some good resources on agile software development?"
4. "I've been thinking about the Dent Conference lineup."
5. (continue freely)

Do NOT explicitly ask Claude to call any tool. Just have a normal conversation.

### 4. Inspect results

```bash
cat /tmp/a6-spike-log.jsonl
# Each line is one invocation of passive_observer, with timestamp + note
```

### 5. Interpret

**If the log has ~1 entry per user message (8-10 entries for an 8-10-turn conversation):** Cowork reliably invokes the passive observer. Phase 6 signal-detector ships as an MCP tool with an always-call description. Design is validated.

**If the log has far fewer entries than turns (e.g., 2 entries for 10 turns):** Claude is skipping calls. The "always-call" instruction is not reliably followed. Phase 6 needs to reshape.

**If the log is empty:** Claude never called the tool. Either the tool isn't discovered in Cowork, or Claude ignored the instruction entirely. Worst case — reshape Phase 6 to explicit-invocation only.

**Edge cases to note in findings:**
- Did Cowork announce "Claude is using the passive_observer tool"? That would break the silent-observation pattern. If yes, Phase 6 must accept the visibility tradeoff or pivot.
- Did Claude use the tool MORE than once per turn (double-invocation)? Would affect rate-limiting logic.
- Did the tool get called when Steve (or any second participant) sent messages in Cowork? That's the actual multi-writer signal we care about.

## Findings (2026-04-22)

```
Date run:                                          2026-04-22
Claude Desktop config:                             Local stdio MCP, added via claude_desktop_config.json
Number of messages in test conversation:           Full conversation (8-10 turns)
Number of passive_observer invocations logged:     0
Hit rate (invocations / messages):                 0%
Did Cowork announce the tool-use visibly? (n/a)    Tool was never invoked, no announcement happened

Verdict: RESHAPE NEEDED. Cowork uses a deferred-tools model.
```

### Root cause

The system-reminder shown to Claude in Cowork explicitly said:

> The following deferred tools are now available via ToolSearch. Their schemas are NOT
> loaded — calling them directly will fail with InputValidationError. Use ToolSearch
> with query "select:<name>[,<name>...]" to load tool schemas before calling them:
> mcp__a6-spike__passive_observer

When asked "what tools do you have?", Claude's response was:
> "I can see there's a tool called mcp__a6-spike__passive_observer in my available tools.
>  Let me load its schema so I can tell you exactly what it does."

So Claude could see the tool was registered, but could NOT invoke it without running `ToolSearch` first to load its schema. Since the "always call me at every turn" instruction lives INSIDE the schema, Claude never had access to that instruction in context — it simply had the tool name.

### Implication for Phase 6

The original design (passive observer MCP tool that Claude reflexively calls every turn) is incompatible with Cowork's deferred-tools model. Even if we could trick Claude into loading the schema once, we have no guarantee the schema stays resident in context across turns. Fragile foundation for a core product feature.

### Reshape

Phase 6 in PLAN.md v1.3 replaces the per-message passive observer with:

1. **Amplification inside `/dent-append-evidence`** — when the user explicitly invokes the skill, it scans recent session context for OTHER Dent entities mentioned and offers multi-append suggestions. Every explicit invocation becomes a multi-append opportunity.

2. **Session-start digest** (`/dent-check`, v1) — one-time info on each new Cowork session about recent Dent activity across the team.

3. **True proactive detection moves to v1 server-side ingest** — Gmail, Granola, Dropbox drop folder. Cowork becomes the query + in-moment capture surface, not the always-on observation surface.

This is both simpler architecturally and more aligned with the v0.9 hybrid architecture (Dent Brain server owns shared state and proactive ingest; Cowork owns user-initiated queries and captures).

### Experiment status: COMPLETE

Answer known. No further test runs needed. The experiment directory stays in-repo as a reference artifact for anyone evaluating similar Cowork MCP patterns in the future (or for OSS consumers of dbrain who want to understand why Phase 6 is shaped the way it is).

## Cleanup after experiment

```bash
# Remove from Claude Desktop config (open the config, delete the a6-spike block)
# Quit and relaunch Claude Desktop
# Remove log file:
rm /tmp/a6-spike-log.jsonl

# The experiment directory stays — it's documented so future spike-runners
# can reproduce. Don't delete unless cleaning up the repo entirely.
```
