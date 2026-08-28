# Backlog

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
