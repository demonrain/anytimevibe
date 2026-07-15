# Multi-CLI Feasibility: Claude Code + Grok Build

Branch: `feat/multi-cli-claude-grok`  
Date: 2026-07-15

## Existing product surface (Codex-driven today)

| Feature | Codex | Claude Code CLI | Grok Build CLI |
|---------|-------|-----------------|----------------|
| Create task in cwd | `thread/start` + `turn/start` | `claude -p` + `--session-id` | `grok -p` + optional `--session-id` |
| Continue conversation | `turn/start` / resume | `-p --resume <session_id>` | `-p --resume <sessionId>` |
| Stream assistant text | app-server item deltas | `--output-format stream-json --include-partial-messages` | `--output-format streaming-json` |
| Permission modes | approvalPolicy + sandbox | `--permission-mode`, `--allowedTools` | `--permission-mode`, `--always-approve` / `--yolo`, `--tools` |
| Mid-turn interactive approval | serverRequest over stdio | Headless usually auto / deny (no interactive card without ACP) | Same; ACP `grok agent stdio` has permissions |
| Interrupt turn | `turn/interrupt` | Kill process | Kill process |
| List tasks | `thread/list` | No first-class list in headless; sessions on disk | `grok sessions list` |
| Snapshot history | `thread/read` | Resume + transcript files | Session store under `~/.grok/sessions` |
| CLI handoff | `codex resume <id>` | `claude -r <id>` | `grok -r <id>` |

## Verdict

| Engine | Support existing AnytimeVibe features? | Notes |
|--------|----------------------------------------|-------|
| **Claude Code** | **Yes (core path)** | Headless `-p` + stream-json + resume is enough for create / continue / stream / stop. Interactive approval cards need ACP or pre-mapped permission modes. |
| **Grok Build** | **Yes (core path)** | Same via headless streaming-json; also has ACP stdio for richer integration later. Sessions list available. |

**Gaps vs Codex (accepted for v1 multi-CLI):**

1. Mid-turn `approval.requested` cards are Codex-first; Claude/Grok map modes to headless auto-approve / acceptEdits / tool allowlists.
2. Task history list for Claude relies on agent-side task index (we create/store sessions); Grok can also list via `grok sessions`.
3. Diff streaming remains best-effort / post-hoc (already incomplete for Codex).

## Architecture choice

Introduce `CliEngine = codex | claude | grok` and a `CliBackend` interface. Codex keeps the long-lived app-server adapter; Claude/Grok use **one process per turn** (headless), with product `threadId` mapped to provider session ids in a local task store.
