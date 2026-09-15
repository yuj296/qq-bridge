# QQ ↔ DeepSeek Harness Bridge (qq-bridge)

**Original author: [Derpyu520](https://github.com/Derpyu520)** — upstream repository: [**Derpyu520/qq-bridge**](https://github.com/Derpyu520/qq-bridge)
**This repository** is a fork maintained by [yuj296](https://github.com/yuj296) (**the DSH 0.1.2 port**), adding protocol support and features on top of the original work. All credit for the original project belongs to its author.

> ## ⚠️ Private chat only — group support has been removed
>
> This fork serves **only the private chat between the owner (`ownerQQ`) and the bot**:
>
> - There is no group-message handler: a group event (`group_id` present) is **silently ignored** — no session, no prompt to the agent, no reply.
> - The MCP surface exposes **30 tools, none of them group-related** (`qq_list_groups`, `qq_get_group_history`, `qq_send_group_message`, … are gone).
> - There is no `allow.groups` / `deny.groups`; only `allow.private` / `deny.private`.
> - The `/api/send/group` route is gone; quoted private replies go through `/api/send/reply` with `body.userId`.
>
> Boundary regression test: `node scripts/test-no-group.mjs`.

> Connect QQ **private** messages to DeepSeek Harness (DSH) agents: a private message from the owner becomes a user message in a DSH session, and agent replies (including questions and tool approvals) are sent back to QQ.

For the detailed Chinese guide, see **[docs/PROJECT_GUIDE.md](docs/PROJECT_GUIDE.md)**.
For a step-by-step installation walkthrough (Chinese, very detailed), see **[INSTALL.md](INSTALL.md)**.

## What this fork adds

| Addition | Details | Where |
| --- | --- | --- |
| **DSH 0.1.2 protocol port** | Upstream depends on `@deepseek-ai/dsh-host-apiproxy`, removed in DSH 0.1.2-alpha.1 — the original cannot connect at all. This fork rewrites the client: cookie auth via `?token=`, auto-discovery of port/token, `$events` waterfall replies, `session/follow` multiplexed event stream | `src/dsh-client.js`, `PORTING-DSH-0.1.2.md` |
| **Private chat only** | All group capability removed: group event entry point, `/api/send/group`, 6 group MCP tools, 16 group config fields, group-flavoured prompt text. Private quoted replies use `/api/send/reply` + `body.userId` | `src/bridge.js`, `src/mcp-snowluma-safe.js`, `plugins/qq-mode-console/lib/schema.js` |
| **"QQ Bot" settings section** | A new section in the DSH settings sidebar (right below *General*), exposing **140 options** in 10 groups with per-field descriptions; saving takes effect within 5s. Precedence: **fields edited in the UI > `config.json` (disk) = console edits > code defaults**; untouched fields are never rewritten | `plugins/qq-mode-console/` |
| **Sidebar "Wake" button** | One row under *Skill Center*: starts SnowLuma + the bridge and sends the owner a QQ message. Local, same-origin requests only (strict IP-literal trust fence; console token never reaches the page) | `plugins/qq-wake/` |
| **Approvals & task-done notifications on your phone** | Tool approvals are relayed to the owner's QQ ("approve"/"deny" to decide); turns longer than 5 minutes (configurable) send a completion notice | `src/bridge.js` |
| **Optional auto-start supervisor (not installed by default)** | Scheduled task + 5-minute watchdog; by default nothing auto-starts — the bot only comes up when you press **Wake** | `tools/README.md` |
| **Docs & self-tests** | `AGENTS.md` (file map / invariants / pitfalls / constraints), porting notes, plugin/wake/settings/no-group test scripts | `AGENTS.md`, `scripts/test-*.mjs` |

## Architecture

```
QQ private messages ──► SnowLuma (OneBot v11 WS) ──► qq-bridge ──► DSH agent session
                                                              ▲              │
                                                              └ replies / questions / approvals ┘
```

- **QQ side**: `@snowluma/sdk` provides the OneBot v11 WebSocket client; only private-chat events are handled.
- **DSH side**: `src/dsh-client.js` implements the 0.1.2 protocol itself (token→cookie auth, endpoint/token auto-discovery, `remote.mux` unary calls and multiplexed event streams) while keeping the legacy call surface, so `bridge.js` business logic did not have to change.
- **Agent tools**: safe MCP servers expose a restricted **private-chat** QQ toolset (`qq_status`, `qq_get_recent_messages`, `qq_send_private_message`, `qq_reply`, `qq_send_message`, … — 30 tools in total). No group tools exist.
- **Console**: a local web console at `http://127.0.0.1:3100` for mode switching, role management, whitelist/admin settings, slang management, memory, stickers and more.

## Features

- Bridges QQ **private** messages to DSH agent sessions.
- Social simulation mode for private chats, with idle/active/probing/exiting states.
- Space-based message splitting for more natural multi-message replies.
- Whitelist/blacklist access control for private chats (`allow.private` / `deny.private`), fail-closed by default.
- Sensitive text audit prevents paths/credentials from being sent to QQ.
- MCP tools for reading messages, sending messages, quoted replies, waiting for messages, and (in `reserved2`) the full self-directed toolset.
- Slang/network-expression learning with human confirmation.
- Lightweight memory system for active topics, pending thoughts and impressions.
- Sticker library integration with AI-friendly sticker usage.

## Requirements

- Node.js >= 22.13
- Running DeepSeek Harness Web (0.1.2; the port and launch token change on every start and are auto-discovered)
- Running SnowLuma with OneBot v11 WebSocket and HTTP API enabled

## Quick Start

```bash
npm install        # postinstall automatically patches the @snowluma/sdk ESM packaging bug
```

Copy `config.example.json` to `config.json`, then edit:

```bash
cp config.example.json config.json
```

Key settings:

| Field | Description |
| --- | --- |
| `dsh.baseUrl` | DSH URL, default `http://127.0.0.1:3080` (auto-discovery when left at the default) |
| `snowluma.wsUrl` | SnowLuma OneBot **WebSocket** URL (e.g. `ws://127.0.0.1:3001`) |
| `snowluma.accessToken` | OneBot access token, leave empty if not configured |
| `snowluma.httpUrl` | OneBot **HTTP API** URL (e.g. `http://127.0.0.1:3000`); do not point this at the WebSocket port or you will get HTTP 426 |
| `ownerQQ` | The owner's **own** QQ number (never the bot account) |
| `allow.private` | Whitelist of QQ numbers allowed to DM the bot |
| `deny.private` | Blacklist of QQ numbers, takes precedence over the whitelist |
| `consolePort` | Local console port, default `3100` |

Start:

```bash
npm start
```

Or double-click `start.bat` on Windows (guard mode with auto-restart).

## DSH Setup on Another Device

The bridge and console can run without extra DSH setup, but the two DSH chat presets (`qq-chat` and `qq-chat-v2`) and the MCP servers must be installed into DSH once per machine:

```bash
node scripts/setup-dsh.mjs
```

This installs:

- `~/.dsh/.agent-presets/qq-chat` and `~/.dsh/.agent-presets/qq-chat-v2`
- MCP entries in `~/.dsh/profiles/web/cordis.patch.yml`
- the `qq-mode-console` plugin as a `file://` patch-layer entry (no `package.json` surgery)
- Default DSH mode set to `reserved2` (second-generation simulation), with a local `state/mode.json` fallback

Then restart DSH if the settings card or MCP tools do not show up. See [docs/DSH_SETUP.md](docs/DSH_SETUP.md) for details.

## Security Notes

- `config.json` and `state/` are **never committed**; the repository only ships `config.example.json`.
- MCP send tools enforce whitelist checks and reject CQ-code injection.
- Local paths, credentials, tokens and other sensitive patterns are filtered by the audit layer.
- Process control for SnowLuma (`start_snowluma` / `stop_snowluma`) is disabled by default and only allowed in `closed-agent` mode when explicitly enabled.
- The console uses a generated token when none is configured.

## Repository Layout

```
qq-bridge/
  AGENTS.md             # project notes for AI agents (file map / invariants / pitfalls)
  config.example.json   # sanitized config template (real config.json is not in repo)
  docs/
    PROJECT_GUIDE.md    # detailed Chinese guide
    DSH_SETUP.md        # DSH-side setup steps (updated for 0.1.2)
  dsh/agent-presets/    # qq-chat / qq-chat-v2 DSH agent preset templates
  plugins/
    qq-mode-console/    # DSH settings "QQ Bot" section (host namespace + client form)
    qq-wake/            # DSH sidebar "Wake" button
  src/                  # bridge core and MCP servers (private chat only)
  public/
    console.html        # local web console
  roles/                # persona cards
  assets/               # images and project intro video
  scripts/              # tests and helper scripts
  state/                # runtime data (not in repo)
```

## Testing

```bash
npm run self-test              # DSH-side link test, no QQ/SnowLuma required
node scripts/test-no-group.mjs # regression: group chat removed, private chat unaffected
npm run test-md
npm run test-wait
npm run test-vision
npm run test-forward
npm run test-slang
npm run test-stickers
```

## Compliance

SnowLuma is an independent third-party project and is not affiliated with Tencent/QQ. This project is for learning and technical research only; please follow the relevant terms and the QQ User Agreement.

This repository is a **fork** of [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge); **the original author is [Derpyu520](https://github.com/Derpyu520)**. The upstream repository ships no LICENSE, so this fork is published in the way GitHub's Terms of Service allow, with attribution in the header and in this section. If you build on this project, keep the original attribution.
