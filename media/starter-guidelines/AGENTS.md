<!--
  AGENTS.md — shared guidance for coding agents working in this repository.
  This is the canonical guideline file. Codex reads AGENTS.md directly; if you
  also use Claude Code, keep CLAUDE.md as a one-line `@AGENTS.md` import so both
  see the same instructions. Delete the sections you do not need and fill in the
  rest — keep it short, concrete, and true.
-->

# Project

<!-- One or two sentences: what this project is, who uses it, what "done" looks
     like for a typical change. -->

TODO: describe the project.

## Setup

<!-- The exact commands to get a working checkout. -->

```
# install dependencies
TODO
```

## Build, test, lint

<!-- The commands an agent should run before calling a change complete. List the
     real command names — an agent will run these verbatim. -->

- Build: `TODO`
- Test: `TODO`
- Lint / format: `TODO`

## Code conventions

<!-- Anything a newcomer would get wrong: language version, module style,
     naming, error handling, where tests live, formatting rules. -->

- TODO

## Do

- Match the style of the surrounding code.
- Add or update tests for behaviour you change.
- Prefer the maintainable fix over the quick one.

## Don't

- Don't commit secrets, credentials, or large generated files.
- Don't reformat unrelated code in the same change.
- Don't add a dependency without a clear reason.

## Commits and pull requests

<!-- Commit message style, branch naming, what a PR description should contain,
     who or what needs to approve. -->

- Commit messages: TODO (e.g. imperative mood, one logical change per commit).
- Pull requests: TODO (what to include, how it gets reviewed).
