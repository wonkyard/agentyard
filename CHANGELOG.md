# Changelog

All notable changes to Agentyard are recorded here.

## 1.0.1

- Office view: a company.db `working` status older than `agentyard.staleWorkingHours`
  (default 3h) now renders as idle, so a department no longer sits at its desk forever when a
  session ends without logging that it finished.
- Run-view terminal: `Ctrl+Shift+Enter` (`Cmd+Shift+Enter` on macOS) inserts a
  newline into the current input line instead of submitting it, for multi-line
  prompts. Plain `Enter` still submits. Gated by `agentyard.terminalCopyPaste`.

## 1.0.0

- **First public VS Code Marketplace release.**
- **Terminal copy / paste.** The Run-view terminal now handles the clipboard.
  `Ctrl+C` / `Cmd+C` copies the selection (and only sends SIGINT when nothing is
  selected); `Ctrl+Shift+C` always copies; `Ctrl+V` / `Cmd+V` /
  `Ctrl+Shift+V` / `Shift+Insert` paste; right-click copies or pastes.
  Clipboard access goes through VS Code (`vscode.env.clipboard`), so it works
  regardless of webview focus quirks. New settings
  `agentyard.terminalCopyPaste` (default `true`) and `agentyard.copyOnSelection`
  (default `false`).
- **Attach a file.** A **📎 Attach** button on the Run view (both the terminal
  and the headless feed) opens the native file picker and splices the selected
  path(s) into the prompt — space-joined, quoted when a path contains spaces,
  never submitted for you.
- **Attach / paste an image.** Paste an image into the terminal or the input
  box, or drag files onto the Run view. Pasted image bytes are written to
  `<workspace>/.agentyard/tmp/` and the path is inserted, since Claude Code
  reads images by path. New settings `agentyard.attachmentsDir` (default
  `.agentyard/tmp`), `agentyard.keepAttachments` (default `false` — the folder
  is cleared on Run-view init and **New thread**) and `agentyard.maxAttachmentMB`
  (default `10`). Attachments are always written inside the first workspace
  folder only, and the bytes are never logged.
- **The office shows a project's team building its repo.** When a build runner is
  live inside a split repo (a subagent whose working directory resolves inside
  that project's `projects.local_path`, or the repo-build runner type), that
  project's annex team (`project-lead` / `project-eng` / `release-check`) now
  shows as **working** — with the runner's current tool as the "doing" line and
  a `building…` sign — instead of sitting idle next to a loose runner sprite.
  Data-driven from `company.db`; path matching is slash-normalised and
  case-insensitive on Windows; with no `company.db` or no `local_path` match it
  falls back to the previous behaviour. If the runner echoes a
  `[agentyard] project-lead -> project-eng` phase marker, only the matching seat
  lights up.
- **Scene header shows the real version.** The `v…` in the office header (and the
  panel topbar) is read from `package.json` via `AY_CONFIG`, not a hardcoded
  string.
- **Demo data shows a repo being built.** `npm run dev` now renders the
  cloud-garden annex as `building…` — a synthetic `repo-team-runner` is working
  inside its `local_path`.

## 0.5.0

- **The Run view is now a real terminal.** Instead of a rendered feed of a
  headless `claude -p` one-shot, the Run view is an embedded terminal
  ([xterm.js](https://xtermjs.org) in the webview, a
  [node-pty](https://github.com/homebridge/node-pty-prebuilt-multiarch)
  pseudo-terminal in the extension host) running an **interactive** Claude Code
  session in the workspace folder. Permission prompts appear in the panel and
  you answer them there; follow-up messages continue the same session; plan mode
  works. It uses your existing CLI login — no API key, no metered billing.
- **`agentyard.claudePermissionMode`** now maps to the real `--permission-mode`
  flag — `plan` starts the session in plan mode. **`agentyard.claudeExtraArgs`**
  is appended verbatim to the interactive launch.
- **New setting `agentyard.runView`** (`terminal` | `headless`, default
  `terminal`). `headless` keeps the 0.4.1 non-interactive feed.
- **Graceful fallback.** node-pty is a native component shipped with prebuilt
  binaries for win32-x64 / linux-x64 / linux-arm64. On any platform where it
  can't load, the Run view falls back to the headless feed automatically with a
  one-line notice, and the Office view is unaffected — the extension still
  activates.
- **New command `Agentyard: Open Claude Code Terminal`** — opens a full
  interactive session in a normal VS Code terminal, using the same
  `agentyard.claudePath` resolution. Always available.
- **Safety unchanged.** The v0.4 no-`cmd.exe` guarantee holds: the CLI is always
  spawned as an argv array with no shell, and a Windows `.cmd`/`.bat` launcher is
  resolved to the real executable it forwards to (or refused). Closing the panel
  or reloading the window kills the pty tree — no orphan `claude`.

## 0.4.1

- **Run feed fixes.** A finished run no longer prints its answer twice (the
  result line is now just a summary — `done · N turns · duration`; the answer
  stays the streamed assistant line above it). Only one `session <id>` line per
  run instead of one per `claude` system record. `claude -p` no longer prints
  "no stdin data received in 3s" — the child's stdin is closed on spawn.

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
  never `shell: true`. There is no safe way to quote arguments for `cmd.exe`, so
  Agentyard never invokes it: a `.cmd`/`.bat` CLI on Windows (e.g. an
  npm-installed `claude.cmd`) is resolved to the real executable it forwards to
  (`node <cli.js>` or a bundled `.exe`) and that is spawned directly, so the
  prompt goes verbatim through `CreateProcess`. A launcher that can't be
  resolved that way is refused with a message asking you to set
  `agentyard.claudePath` to the real program — Agentyard will not run it through
  a shell. The prompt and the run output are never written to disk by
  Agentyard — the child's stdout goes only to the webview.
- **Zombie sessions clear themselves.** If VS Code is force-closed or crashes
  mid-run, the killed Claude Code sessions never report finishing, so their
  activity used to hang around the Office scene as idle rooms forever. A live
  agent with no finish event and no activity for `agentyard.staleMinutes`
  (default 15) is now treated as dead and dropped, and its stale event log is
  cleaned up within a couple of hours instead of a day.
- **Live-mode hook survives updates.** The hook is now copied to a stable
  `~/.claude/agentyard/agentyard-hook.mjs` and `settings.json` points there,
  instead of at the version-named extension folder (which every update
  replaced, silently breaking live activity). Existing installs are migrated on
  first launch.
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
