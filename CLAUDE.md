# agentyard — Product Operating Manual

This repo is a single WONKYARD product, split out from the company repo (`wonkyard/company`)
by `repo-manager`. It runs its own small team, sized to operate one product — not the whole
company. The company's Chief of Staff coordinates across repos; inside this repo, the team
below coordinates itself.

`project_id`: `<project_id>`
Company repo: `wonkyard/company`

## Team

| Agent | Model | Role |
|-------|-------|------|
| `project-lead` | sonnet | Owns this product's direction and backlog — decides what to build or fix next, writes it down as a short PRD/backlog entry. Does not write code. |
| `project-eng` | sonnet | Implements what `project-lead` prioritized. Owns tests. Marks work READY FOR RELEASE CHECK. |
| `product-ops` | haiku | Periodically scans for update opportunities (outdated deps, competitor gaps) and monetization opportunities. Observes and recommends only. |
| `daily-reporter` | haiku | On demand, compiles "what happened in this repo" (git log, commits, reports, open TODOs) into a standard report and logs a one-line summary back to the company DB. |
| `release-check` | sonnet | Called right before any `git push` or PR. Reviews the diff, decides PASS or BLOCK. Never edits code. |

## Shared state

When this repo's working copy is nested inside a company-repo checkout, the shared state DB is
reachable at `../../state/company.db`. Agents read it for Gate history / pricing decisions and
write status rows to it. When the repo is standalone (cloned elsewhere), agents skip the DB and
just write local reports — that is not an error.

## Standard flow

```
project-lead   -> decides next priority, writes reports/backlog.md entry
project-eng    -> implements + tests, marks READY FOR RELEASE CHECK
release-check  -> PASS/BLOCK on the diff
(Founder-aware push)
product-ops    -> runs on its own cadence, recommends
daily-reporter -> runs when the company asks "what did you do", produces reports/daily/<date>.md
```

## Releasing

Releases are cut by pushing a version tag — no local PAT handling:

```
npm version patch          # bumps package.json, makes the commit + vX.Y.Z tag
git push origin main --follow-tags
```

The tag push triggers `.github/workflows/release.yml`, which runs `npm ci`, guards that the
tag matches `package.json` version, runs `npm run sanity`, packages the `.vsix` with the
pinned `@vscode/vsce` devDependency, publishes to the marketplaces, and attaches the `.vsix`
to a GitHub Release for the tag.

Two repo secrets must be set (**Settings → Secrets and variables → Actions**):

| Secret | Used for |
|--------|----------|
| `VSCE_PAT` | VS Code Marketplace publish (`vsce publish`) |
| `OVSX_PAT` | Open VSX publish (`ovsx publish`) |

If either secret is missing the matching publish step is skipped with a warning (a fork
still gets a packaged `.vsix` on the Release); the run does not fail.

## Rules

- No agent pushes or commits on its own. `release-check` must PASS first, and every push needs
  Founder awareness — same rule as the company repo.
- Reports go in `reports/<agent>/<date>.md` (daily reports in `reports/daily/<date>.md`).
- Keep recommendations grounded in something actually found — real version numbers, real
  competitor features, real commits. Never speculate as fact.

## Maintenance: the embedded terminal (node-pty)

The Run view's terminal (v0.5+) has one real maintenance cost: **`node-pty` is a
native module and must match the Node/Electron ABI that VS Code runs.**

Since v1.1 there can be **several pty instances at once — one per enabled backend**
(`agentyard.agents`: Claude Code, Codex, …), each held in the extension host by
its own `TerminalRun`. Same ABI requirement, just more instances; panel dispose
kills them all (`OfficeViewProvider.disposeTerms`).

- We depend on `@homebridge/node-pty-prebuilt-multiarch`, pinned exactly in
  `package.json`. It ships prebuilt binaries inside the npm package for many
  ABIs. xterm.js / addon-fit are pinned there too and vendored into
  `webview/vendor/` by `npm run vendor` (same as sql.js) — no CDN, ever.
- **What ships in the `.vsix`:** `.vscodeignore` re-includes
  `node_modules/@homebridge/node-pty-prebuilt-multiarch/**` and drops only its
  dev weight (`src/`, `scripts/`, `binding.gyp`, `*.pdb`, `*.map`). Always check
  `vsce ls` before publishing: the `build/Release/*.node` (Windows) and
  `prebuilds/<platform>-<arch>/*.node` (others) for your target platforms must
  be present, and nothing from `dev-data/real/`, `reports/`, `.env`, or `state/`.
- **When VS Code bumps its Electron engine** (`engines.vscode` in `package.json`)
  the shipped prebuilds may no longer cover the new ABI. On a networked machine:

  ```
  # find the Electron/ABI VS Code now uses:  Help → About  (or `process.versions`)
  npm install                                  # refetches prebuilds for this host
  npx prebuild-install \
    -r electron -t <electron-version> \
    --platform <win32|darwin|linux> --arch <x64|arm64> \
    -d node_modules/@homebridge/node-pty-prebuilt-multiarch
  # repeat --platform/--arch per target, then `vsce ls` to confirm, then package
  ```

  If a prebuild genuinely isn't available, the graceful-degradation path in
  `extension.js` (try/catch around `require`, `agentyard.runView` auto-falls to
  `headless`) keeps the extension working — that is the safety net, not an
  excuse to ship a broken terminal.
- **Do not** switch to plain `node-pty` with an `electron-rebuild` step in CI
  without updating this section and `README`'s *How it's built* — a hidden build
  requirement is exactly what this note exists to prevent.
