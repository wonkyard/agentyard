'use strict';

/**
 * Pure decision logic for `Agentyard: Set Up Agent Guidelines`.
 *
 * Model: **AGENTS.md is canonical.** Codex reads `AGENTS.md`; Claude Code reads
 * `CLAUDE.md`. To keep both in sync with zero drift, `CLAUDE.md` becomes a thin
 * pointer that imports `AGENTS.md` (`@AGENTS.md` — a Claude Code file import), so
 * it always reflects the canonical file.
 *
 * No fs, no vscode — the extension does the reads/writes/backups (same
 * discipline as the settings.json hook merge), this module only decides what
 * should happen and produces the exact file bodies. The sanity test exercises
 * it directly.
 */

// The one-line import Claude Code resolves at load time.
const IMPORT_LINE = '@AGENTS.md';
// The comment that goes with a pointer CLAUDE.md. No other product names.
const POINTER_COMMENT =
  '<!-- Canonical guidance lives in AGENTS.md — Claude Code imports it. Edit AGENTS.md. -->';

function norm(text) {
  return String(text == null ? '' : text).replace(/\r\n/g, '\n');
}

/** Exact body of a pointer CLAUDE.md: the import line + a one-line comment. */
function pointerText() {
  return IMPORT_LINE + '\n' + POINTER_COMMENT + '\n';
}

/** Is this CLAUDE.md nothing but the `@AGENTS.md` import (+ comments / blanks)? */
function isPointer(text) {
  const lines = norm(text)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !l.startsWith('<!--'));
  return lines.length === 1 && lines[0] === IMPORT_LINE;
}

/** Does the text already contain the `@AGENTS.md` import on its own line? */
function hasImport(text) {
  return norm(text).split('\n').some((l) => l.trim() === IMPORT_LINE);
}

/**
 * "append the import" body: the user's existing CLAUDE.md, untouched, with the
 * `@AGENTS.md` import added at the end. Nothing is moved.
 */
function appendImportText(existing) {
  const base = norm(existing).replace(/\s*$/, '');
  return (base ? base + '\n\n' : '') + IMPORT_LINE + '\n';
}

/**
 * "make CLAUDE.md a pointer" — the CLAUDE.md body moves into AGENTS.md. Returns
 * the new AGENTS.md body: the existing AGENTS.md (if any) with the moved
 * CLAUDE.md content appended under a labelled divider, or just the CLAUDE.md
 * content when there was no AGENTS.md yet.
 */
function mergedAgentsText(existingAgents, claudeBody) {
  const a = norm(existingAgents).replace(/\s*$/, '');
  const c = norm(claudeBody).replace(/^\s*/, '').replace(/\s*$/, '');
  if (!c) return a ? a + '\n' : '';
  if (!a) return c + '\n';
  return a + '\n\n<!-- moved from CLAUDE.md by Agentyard -->\n' + c + '\n';
}

/**
 * Sync-status label for the panel indicator.
 *   in-sync      — both files exist, CLAUDE.md points at / imports AGENTS.md
 *   only-agents  — AGENTS.md only
 *   only-claude  — CLAUDE.md only
 *   diverged     — both exist, CLAUDE.md is real content that does not import AGENTS.md
 *   n/a          — neither exists
 *
 * @param {{agentsMd:boolean, claudeMd:boolean, claudeText?:string}} s
 */
function classify(s) {
  const a = !!(s && s.agentsMd);
  const c = !!(s && s.claudeMd);
  if (!a && !c) return 'n/a';
  if (a && !c) return 'only-agents';
  if (!a && c) return 'only-claude';
  if (isPointer(s.claudeText) || hasImport(s.claudeText)) return 'in-sync';
  return 'diverged';
}

/**
 * What the command should do given the current state.
 *   { action: 'create', createClaudePointer }      — neither file exists
 *   { action: 'choose', choices:[…], hasAgents }    — a real CLAUDE.md is in the way
 *   { action: 'none', status }                      — already handled
 *
 * @param {{agentsMd:boolean, claudeMd:boolean, claudeText?:string, claudeEnabled?:boolean}} s
 */
function plan(s) {
  const a = !!(s && s.agentsMd);
  const c = !!(s && s.claudeMd);
  const claudeEnabled = s && s.claudeEnabled !== false;
  if (!a && !c) return { action: 'create', createClaudePointer: !!claudeEnabled };
  if (c && !isPointer(s.claudeText) && !hasImport(s.claudeText) && claudeEnabled) {
    return { action: 'choose', hasAgents: a, choices: ['keep-separate', 'append-import', 'make-pointer'] };
  }
  if (!a && c && !claudeEnabled) {
    // only CLAUDE.md, Claude Code not enabled → seed AGENTS.md from it
    return { action: 'create', fromClaude: true, createClaudePointer: false };
  }
  return { action: 'none', status: classify(s) };
}

module.exports = {
  IMPORT_LINE,
  POINTER_COMMENT,
  pointerText,
  isPointer,
  hasImport,
  appendImportText,
  mergedAgentsText,
  classify,
  plan,
};
