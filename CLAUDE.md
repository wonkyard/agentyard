# pixel-office — Product Operating Manual

This repo is a single WONKYARD product, split out from the company repo (`wonkyard/company`)
by `repo-manager`. It runs its own small team, sized to operate one product — not the whole
company. The company's Chief of Staff coordinates across repos; inside this repo, the team
below coordinates itself.

`project_id`: `TOOL-20260828-1008`
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

## Rules

- No agent pushes or commits on its own. `release-check` must PASS first, and every push needs
  Founder awareness — same rule as the company repo.
- Reports go in `reports/<agent>/<date>.md` (daily reports in `reports/daily/<date>.md`).
- Keep recommendations grounded in something actually found — real version numbers, real
  competitor features, real commits. Never speculate as fact.
