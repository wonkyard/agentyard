---
# name: the room label in Agentyard, and the name you call this agent by.
#       Use a short lowercase word. This must match the file name.
name: _template
# description: one or two sentences — what this department is responsible for.
#              Shown in the info panel when you click the room.
description: A blank department. Copy this file, rename it, and fill in the frontmatter.
# model: which Claude model this agent runs on. Agentyard colours the room's
#        stripe by this (teal = sonnet, yellow = haiku).
model: sonnet
# tools: the tools this agent is allowed to use, space- or comma-separated.
#        Common: Read, Write, Edit, Bash, Grep, Glob, WebSearch.
tools: Read, Write
---

Write the agent's instructions here, below the frontmatter — its role, how it
should work, and what "done" looks like for it.

To add a department: copy this file to `~/.claude/agents/<name>.md` (or your
workspace's `.claude/agents/<name>.md`), set `name:` to `<name>`, and edit this
body. Agentyard picks it up on the next refresh — no restart.
