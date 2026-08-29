# Backlog

## 2026-08-29 — v0.5: replace the Run feed with a real embedded terminal

Why: The Founder wants the Run view to behave exactly like the Claude Code
terminal — interactive permission prompts answered in the panel, one live
session with follow-ups and plan mode — not a headless `claude -p` one-shot that
denies every non-pre-allowed tool. Company spec:
`../company/reports/TOOL-20260828-1008/v0.5-terminal.md` (architecture settled
there — do not re-litigate: xterm.js in the webview + node-pty in the extension
host, spawning the user's own interactive `claude`).

Scope (exactly the spec's items):

1. **Embedded terminal.** Vendor xterm.js + addon-fit into `webview/vendor/` the
   same way `sql-wasm.js` is (pinned versions in `scripts/vendor.mjs`, LICENSE
   checked in, no CDN, CSP-safe nonce/`<link>`). Run view becomes an xterm
   surface wired to a `node-pty` in the extension host over the existing
   `postMessage` channel (`{type:'term', event:'input'|'resize'}` in,
   `{type:'term', event:'data'|'exit'}` out). New `TerminalRun` class spawns the
   resolved real `claude` exe (interactive, NOT `-p`, no `--output-format`)
   with `--permission-mode <mode>` when not `default` and `claudeExtraArgs`
   verbatim, cwd = first workspace folder. Keep the v0.4 no-cmd.exe guarantee
   (`shared/winWrap.js` shim resolution; refuse if a Windows shim can't be
   resolved). One pty per panel, kept in the extension host so a webview reload
   re-attaches; `killTree` on "New thread", panel dispose, and deactivate.
2. **node-pty**: use a prebuilt-multiarch build so a published `.vsix` works on
   win32-x64 / darwin-x64 / darwin-arm64 / linux-x64 without a compiler. Document
   the Electron-ABI rebuild step in `CLAUDE.md` for future engine bumps.
3. **Config**: add `agentyard.runView` (`terminal` | `headless`, default
   `terminal`); drop the "headless can't answer prompts" note from
   `claudeExtraArgs`; keep `claudePermissionMode` (now the real flag).
4. **Graceful degradation**: `require(node-pty)` in try/catch — on failure the
   Run view falls back to `headless` automatically with a one-line notice, the
   Office view is untouched, the extension still activates.
5. **Fallback command** `agentyard.openClaudeTerminal` — "Agentyard: Open Claude
   Code Terminal" — `vscode.window.createTerminal` + `sendText(resolvedClaude)`,
   same path resolution, always available.
6. **Markdown (spec §2)**: check whether any assistant text is still rendered as
   HTML after §1; if not, close with a note (no unused renderer).
7. **Packaging**: `.vscodeignore` ships the native module + prebuilt binaries,
   nothing dev-only; verify with `vsce ls`. Bump to `0.5.0`, update
   `CHANGELOG.md` + `README.md`. `npm run sanity` stays green with new checks.

Out of scope: Office view / pixel scene / live hook mode / DB reader / zombie
horizon (untouched); Marketplace publish; syntax highlighting; multiple
concurrent terminals; terminal theme UI.

Done when: in the Extension Dev Host the Run view is a real terminal running an
interactive `claude` (permission prompt answerable in-panel, follow-ups continue
the same session, `claudePermissionMode: "plan"` starts in plan mode); no
cmd.exe (sanity green + new checks); no orphan `claude` after panel close /
window reload; node-pty missing -> headless fallback + notice, Office view fine;
`vsce ls` reviewed; `agentyard-0.5.0.vsix` builds; repo `release-check` = PASS.

Priority: now

## 2026-08-28 — v0.4 Release Gate FAIL round 1: close the two Criticals + two Mediums

Why: The company Release Gate failed v0.4 on branch `v0.4-run` (`03ed6d3`). Two
Critical findings block the merge; two Mediums came with the same brief and are
cheap to fix in the same pass. Brief:
`../company/reports/<project_id>/v0.4-gate-fail-round1.md`.

Scope (exactly the four brief items):

1. **CRITICAL — cmd.exe command injection / RCE in `shared/winWrap.js`.**
   The `CommandLineToArgvW`-style `quoteArg` + `cmd.exe /d /s /c` wrapper does not
   contain cmd.exe metacharacters; an unbalanced `"` in a prompt before `& | < >`
   breaks out and runs arbitrary commands. `%VAR%` is also silently expanded.
   Fix: brief option 2 — resolve the `.cmd`/`.bat` shim to the real executable it
   forwards to (`node <cli.js>` or a bundled `.exe`) and spawn that directly with
   **no shell**, so the prompt goes verbatim through `CreateProcess` and cmd.exe
   is never involved. If a shim can't be recognised, refuse with a clear message
   telling the user to point `agentyard.claudePath` at the real executable
   (brief option 3) — no unsafe cmd.exe fallback anywhere.

2. **CRITICAL — zombie agents/rooms survive a VS Code force-close.**
   `webview/js/live.js resolve()` keeps forever any agent with no terminal event;
   `extension.js prune()` keeps its events file for 24h. Fix: add an absolute
   staleness horizon in `resolve()` (`STALE_MS`, default 15 min, configurable via
   `agentyard.staleMinutes`) that drops non-ended agents whose newest activity is
   older than the horizon — not rendered, not counted. Shorten `prune()` to drop
   an `events-*.jsonl` after ~2h of silence regardless of a terminal event, and
   run it every few minutes rather than hourly.

3. **MEDIUM — spawn-level regression test for the Windows launcher path.**
   `scripts/sanity.mjs` only checks wrapper output-string shape. Add a test that
   actually spawns a real npm-style `.cmd` shim (fixture) through the same resolve
   path the extension uses, with a `"` + `&` prompt, and asserts the child got the
   argv verbatim and that no extra process ran / no file was created.

4. **MEDIUM — live-mode hook installed at a version-pinned extension path.**
   `enableLiveMode()` writes `node "<extensionDir>/hooks/agentyard-hook.mjs"` into
   `~/.claude/settings.json`; `<extensionDir>` is version-named, so every update
   breaks the installed hook. Fix: on activation copy the bundled hook to a stable
   `~/.claude/agentyard/agentyard-hook.mjs` (re-copy when the bundled one is
   newer) and point `settings.json` there. Cross-platform (`path.join` +
   `os.homedir()`).

Then: correct the `CHANGELOG.md` 0.4.0 "Safety" wording and the `winWrap.js`
header comment so the claims are true; `npm run sanity` ALL PASS; rebuild
`agentyard-0.4.0.vsix`.

Out of scope: anything not in the four items above — no new Run-view features, no
renderer changes, no `<project_id>` string cleanup in `.claude/**` (handled
in company public-release prep). No new milestone.

Done when:
- A prompt containing `" & echo OWNED > PWNED.txt & rem` run through the Windows
  launcher path reaches the child as one literal argv element; no `PWNED` file is
  created; `%VAR%` is not expanded.
- `resolve()` fed an event stream that ends without `Stop`/`SessionEnd` and a
  `nowMs` past the staleness horizon returns zero agents; the real
  `zombie-session-fixture.jsonl` renders nothing once `nowMs` is well past its
  last event.
- `npm run sanity` prints `ALL PASS` (with the two new checks).
- `agentyard-0.4.0.vsix` rebuilt.

Priority: now — `project-eng` to implement.
