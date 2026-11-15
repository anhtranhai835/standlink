# Standlink design

Date: 2026-11-15 · Status: approved direction, UI-first

## Intent

A local app where Claude orchestrates other coding agents (Codex, Antigravity, Cursor) over ACP.
Agents can message each other, every agent's progress is visible, and when one provider hits its
usage limit another picks the task up from a short checkpoint instead of replaying the transcript.
Token cost is the top priority. Local only, non-commercial, public on GitHub as a portfolio piece.

## Goals

- See every agent's state (idle, working, blocked on permission, rate limited, done), current step and file.
- Agents talk to each other through Standlink, never directly.
- Handoff on rate limit costs a few hundred tokens (checkpoint), not the full transcript.
- UI with a loud, playful JoJo spirit: each agent is a Stand user, events play as Stand moves.

## Non-goals

- No cloud, no accounts, no billing. No API-key mode (subscription CLIs only).
- No agent-to-agent channel outside Standlink.

## Anti-goals

- A handoff that silently re-reads the whole transcript (defeats the purpose).
- Guessing agent state by scraping terminal text when ACP events exist.

## Approaches considered

| Approach | Trade-off | Verdict |
|---|---|---|
| Terminal multiplexer (herdr style) | Works with any CLI; state guessed from screen text, no token data | Fallback only for agents without an ACP adapter |
| Desktop app wrapping terminals (Orca style) | Great UX; still terminal-based underneath | Borrow the UX: coordinator + workers, one worktree each |
| **ACP-native client** | Structured `session/update` events (plan, tool_call, message chunks); needs an ACP adapter per CLI | **Chosen** |

## Architecture

```
Standlink (ACP client + web UI)
 ├─ ACP session ─ claude-code adapter   (orchestrator)
 ├─ ACP session ─ codex adapter         (worker)
 ├─ ACP session ─ antigravity / cursor  (worker; terminal fallback if no ACP adapter)
 └─ every session/new attaches Standlink's own MCP server (web/electron/mcp-bridge.mjs), tools:
      board()                      members, state, current tasks (one line each)
      assign(member, task, brief)  give work; the assigner gets a one-line report when it is done
      ask(member, message)         short question; the answer is relayed back to the asker
```

Built (2026-11-15): Electron desktop app (`web/electron/main.ts`), hand-written ACP client
(`acp.ts`, JSON-RPC over stdio, verified with `@agentclientprotocol/codex-acp`), MCP bridge run by
Electron itself (`ELECTRON_RUN_AS_NODE`) and reached over a token-checked localhost endpoint
(verified: Codex called `mcp.standlink.board`). Handoff notes are not an agent tool: Standlink
writes them itself from recorded ACP events (`buildCheckpoint` in `web/src/world.ts`), so a
rate-limited agent spends zero tokens on them. Team rules go out once per agent session, not per turn.

- Agent state comes from ACP events. Rate limit = `session/prompt` error or abnormal `stopReason`.
- Checkpoint schema: task id, done steps, touched files, next step, open questions. Target < 400 tokens.
- One git worktree per worker task.
- To verify during build: exact adapter packages for Claude Code and Codex, whether Cursor and
  Antigravity have ACP adapters.

## UI (approved 2026-11-15; driven by a demo event script with the same event shapes the backend will emit)

Layout copied from Orca, skinned in JoJo style (`web/src/App.tsx`, `components.tsx`, `orca.css`):

- **Sidebar:** project search; Tasks and Providers sections that expand in place; PROJECTS tree.
  The open project lists its agents nested underneath, each with 👑 (make orchestrator), ✕ (drop a
  sub-agent) and a "+ Sub-agent" picker.
- **Projects = sessions:** each project has its own team, orchestrator and run, and keeps running in
  the background when another project is open. Shown as tabs across the top.
- **Providers are user data, not code:** name + the command that speaks ACP (Kimi, DeepSeek, …).
  The four defaults are only a starting list. A team can hold several members of one provider.
  Team size 4–8 (orchestrator + at least 3 workers).
- **Panes:** one per agent in a 2×2 / 3×2 / 4×2 grid, orchestrator first. Each pane: header,
  JoJo stage (the Stand attacks its task block, steps are HP), Orca-style transcript, and its own
  composer with an access chip (ask first / full access = auto-approve permission requests).
  The orchestrator's composer orders the whole team; a worker's composer talks to that agent.
- **Status bar:** quota and tokens per provider, total tokens, tokens saved by handoffs.
- **Event overlays:** new task = "PART n"; rate limit = TIME STOP (inverted colors, clock);
  checkpoint = TO BE CONTINUED (sepia); handoff = rewind swirl; permission = ゴゴゴ with Approve /
  Deny; task done = finisher move + "TASK CLEAR". Messages and checkpoints fly between panes.
- **Casting:** characters are random per member and can be rerolled (🎲); no provider owns a
  character. State to sprite row: idle row when idle/blocked/limited (limited frozen and gray),
  work row while working, special row when talking or taking over, finisher row on done.
- Projects, teams, casting and providers persist in localStorage.

Known gaps for the backend phase: quota is tracked per member, but members of one provider share a
real account quota; the demo ignores the typed order and always plays the same task set.

## Assets and copyright

JoJo sprite sheets are generated locally and kept out of git (`web/public/sprites/`,
`prototype/assets/`). The public repo ships without them; cards show a placeholder when missing.

## Build order

1. UI with demo script (this phase).
2. ACP client for Claude Code + Codex, real events into the same store.
3. MCP server with checkpoint / handoff / ask tools.
4. Rate-limit detection and automatic handoff.
5. Remaining agents (ACP or terminal fallback).
