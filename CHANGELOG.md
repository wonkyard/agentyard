# Changelog

All notable changes to Agentyard are recorded here.

## 0.4.0

- **Run Claude Code from the panel.** A header toggle switches between the
  **Office** scene and a new **Run** view: an input box plus a scrollable feed.
  Sending a prompt spawns `claude -p "<prompt>" --output-format stream-json
  --verbose` as a child process in the workspace folder, using your existing
  Claude Code CLI login — no API key, no metered billing. The NDJSON stream is
  rendered as a feed: your prompt, assistant text, tool calls as compact lines
  (`→ Bash: npm test`), tool results, and a final summary with turn count and
  duration.
- **One run at a time.** A **Cancel** button kills the whole process tree
  (`taskkill /T` on Windows, process-group signal elsewhere). A **New thread**
  button starts a fresh conversation; otherwise each message continues the same
  thread via `--resume`.
- **Safety.** The prompt is always a spawn argument — never a shell string, and
  never `shell: true`. A `.cmd`/`.bat` CLI on Windows is run through `cmd.exe`
  with every argument individually quoted. The prompt and the run output are
  never written to disk by Agentyard — the child's stdout goes only to the
  webview.
- New settings: `agentyard.claudePath` (default `claude`; on Windows also tries
  `claude.exe` / `claude.cmd`), `agentyard.claudeExtraArgs` (string array, e.g.
  `["--allowedTools", "Read Edit Bash(npm test)"]`), and
  `agentyard.claudePermissionMode` (default `default` — headless runs cannot
  answer permission prompts, so pre-allow tools in settings or via extra args).
- Because the spawned `claude` inherits any installed Agentyard hooks, its own
  work also shows up as live rooms in the Office view.
- Browser dev (`npm run dev`) stubs the Run view — it shows "available inside
  VS Code" plus a canned sample feed from a synthetic fixture for layout work.

## 0.3.0

- **Live activity from Claude Code, for any workspace.** Agentyard can now show
  what your agents are actually doing right now, not just the last row in a
  project database. A bundled hook script (`hooks/agentyard-hook.mjs`) appends
  Claude Code lifecycle events to `~/.claude/agentyard/events-<session>.jsonl`;
  the extension tails those files and resolves each agent to
  working / idle / blocked with a one-line "what it's doing".
- **Opt-in, never silent.** "Turn on live mode" (a command, and a click target
  on the header pill) shows the exact JSON that will be merged into your
  `~/.claude/settings.json` and asks before writing it. The merge is
  non-destructive — your existing hooks are kept — and "turn off live mode"
  removes only Agentyard's entries. A `settings.json.agentyard-backup` is written
  first.
- Roster now merges the workspace `.claude/agents/`, your user `~/.claude/agents/`,
  and any agent types seen in live events (including built-ins like `Explore`).
- Live sessions and subagents render as their own rooms above the departments;
  a room busier than `agentyard.maxSpritesPerRoom` shows "+N more".
- Header badge shows `LIVE` / `WATCHING` / `DEMO DATA` / `hooks off`.
- `state/company.db` is now an optional third layer (the company board and Gate
  history) rather than the only source of "who's working".

## 0.2.2

- Much sharper text. The scene now renders at 2× and is scaled down to the panel
  width by the browser, instead of a 1× canvas being stretched with
  `image-rendering: pixelated` (which was shredding every label). Bumped the
  smallest font sizes and switched to a cleaner monospace stack.

## 0.2.1

- Fixed the packaged extension hanging on "loading Agentyard…". The webview
  Content-Security-Policy was missing `connect-src`, so sql.js could never fetch
  its `.wasm` and the company DB never loaded. (Only the packaged/installed
  extension was affected; `npm run dev` in a browser was fine.)
- The webview now draws the actual error text on the canvas when data loading
  fails, instead of sitting on the loading screen forever.

## 0.2.0

- Renamed the extension to **Agentyard**. (During early development the repo was
  briefly named `pixel-office`; all identifiers, config keys, commands and the
  `AGENTYARD_REPO` env var now use the `agentyard` name. The old
  `PIXEL_OFFICE_REPO` env var is still read as a deprecated fallback.)
- **Bottom-panel tab.** Agentyard now shows up as its own tab in the VS Code
  panel (next to Terminal / Output / Problems / Ports) via a
  `viewsContainers.panel` container and a `WebviewViewProvider`. It activates
  `onStartupFinished`, so the tab is there without running any command. Added an
  `agentyard.focus` command as a convenience for keybindings. The old
  editor-tab command was removed.
- Webview wiring (HTML, CSP + nonce, postMessage snapshots, 3s poll, file
  watchers) moved from the editor `WebviewPanel` into the panel view, with
  `retainContextWhenHidden`.
- Responsive layout for the panel: the scene scrolls inside its own container
  (horizontal when narrow, vertical when short) and never overflows; the info
  panel docks right on wide layouts and slides up from the bottom when narrow.
- **Living scene.** Idle agents walk a path around their room with a 3-frame
  walk cycle and turn at the walls; working agents sit and type with a glowing
  monitor and a thought bubble showing their latest note; blocked agents stand
  and bounce a red `!`. Rooms gained a desk, chair, monitor, plant, bookshelf,
  door, floor pattern, rug and a wall sign. Project annexes are drawn as
  distinct brick buildings with a stepped roof and a hanging sign. Added a
  slow day tint, a vignette and gentle ambient motion.
- Added a real extension icon (`media/icon.png`, 128×128 pixel-art, generated by
  `npm run icon`) and a panel-container icon (`media/panel-icon.svg`).
- `npm run sanity` extended to also check the panel-view manifest contributions
  and that no legacy identifiers remain in shipped code.

## 0.1.0

- First internal build: canvas pixel-art office read from a local
  `state/company.db` + `.claude/agents/`, with bundled synthetic demo data,
  a browser dev server, and a headless sanity check.
