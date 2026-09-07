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

/**
 * The persistent panel chip (v1.2). Given the `classify()` sync label, decide
 * what the chip says, how loud it looks, and what a click does. Pure so the
 * sanity test can pin every case; the extension computes it into the snapshot
 * and the webview just renders label/tone/action.
 *
 *   action 'setup'          → run `agentyard.setupGuidelines` (create / adopt flow)
 *   action 'sync'           → re-point CLAUDE.md at @AGENTS.md (one modal confirm, backup first)
 *   action 'create-pointer' → create a CLAUDE.md @AGENTS.md pointer next to AGENTS.md
 *   action 'open'           → nothing to fix; just open AGENTS.md
 *
 * @param {string} sync  one of 'in-sync'|'only-agents'|'only-claude'|'diverged'|'n/a'
 * @param {{claudeEnabled?:boolean, hasWorkspace?:boolean}} [opts]
 * @returns {{show:boolean, tone:'ok'|'warn'|'muted', label:string, action:string, hint:string}}
 */
function chipState(sync, opts) {
  opts = opts || {};
  const claudeEnabled = opts.claudeEnabled !== false;
  const hasWorkspace = opts.hasWorkspace !== false;
  switch (sync) {
    case 'in-sync':
      return { show: true, tone: 'ok', label: 'guidelines in sync', action: 'open',
        hint: 'CLAUDE.md imports AGENTS.md — both agents see the same instructions.' };
    case 'diverged':
      return { show: true, tone: 'warn', label: 'CLAUDE.md diverged', action: 'sync',
        hint: 'CLAUDE.md is its own content. Click to re-point it at @AGENTS.md (a backup is saved first).' };
    case 'only-agents':
      return claudeEnabled
        ? { show: true, tone: 'warn', label: 'no CLAUDE.md pointer', action: 'create-pointer',
          hint: 'AGENTS.md exists but Claude Code has no CLAUDE.md. Click to add a @AGENTS.md pointer.' }
        : { show: true, tone: 'ok', label: 'AGENTS.md set up', action: 'open',
          hint: 'AGENTS.md is set up. Claude Code is not enabled, so no CLAUDE.md is needed.' };
    case 'only-claude':
      // v1.4: one modal confirm now does the whole thing — copy CLAUDE.md into a
      // canonical AGENTS.md and reduce CLAUDE.md to the @AGENTS.md pointer. No
      // multi-step quick-pick for the common case.
      return { show: true, tone: 'warn', label: 'no AGENTS.md', action: 'sync',
        hint: 'Only CLAUDE.md exists. Click to copy it into a canonical AGENTS.md and make ' +
          'CLAUDE.md a "@AGENTS.md" pointer (both backed up first).' };
    case 'n/a':
    default:
      return { show: hasWorkspace, tone: 'muted', label: 'set up guidelines', action: 'setup',
        hint: 'No AGENTS.md / CLAUDE.md yet. Click to scaffold them.' };
  }
}

/**
 * The "Sync now" write plan: CLAUDE.md becomes exactly `pointerText()`, and the
 * existing file is backed up first. Pure — the extension resolves the path and
 * does the fs work with the same `backupThenWrite` discipline as v1.1.
 */
function syncPointerPlan() {
  return { file: 'CLAUDE.md', content: pointerText(), backupFirst: true };
}

/**
 * v1.4: the one-click write set for a header-chip click, given the `classify()`
 * sync label and the current file bodies. The extension applies each write with
 * the same `.agentyard-backup` discipline; `backupFirst` is true only for a file
 * that already exists.
 *
 *   only-claude              -> AGENTS.md = the CLAUDE.md body, CLAUDE.md = pointer
 *   only-agents (+ claude)    -> CLAUDE.md = pointer
 *   diverged                  -> CLAUDE.md = pointer (syncPointerPlan)
 *   in-sync / n/a / only-agents (claude off) -> no writes
 *
 * @param {string} sync
 * @param {{claudeText?:string, agentsText?:string, claudeEnabled?:boolean}} [opts]
 * @returns {{writes:Array<{file:string,content:string,backupFirst:boolean}>, open:string, summary:string}}
 */
function oneClickPlan(sync, opts) {
  opts = opts || {};
  const claudeText = norm(opts.claudeText);
  const agentsText = norm(opts.agentsText);
  const claudeEnabled = opts.claudeEnabled !== false;
  const claudeExists = !!claudeText.trim();
  const agentsExists = !!agentsText.trim();
  const none = { writes: [], open: 'AGENTS.md', summary: '' };

  switch (sync) {
    case 'only-claude': {
      const body = claudeText.replace(/^\s+/, '').replace(/\s+$/, '') + '\n';
      return {
        writes: [
          { file: 'AGENTS.md', content: body, backupFirst: agentsExists },
          { file: 'CLAUDE.md', content: pointerText(), backupFirst: claudeExists },
        ],
        open: 'AGENTS.md',
        summary: 'copy CLAUDE.md into a canonical AGENTS.md, then make CLAUDE.md a "@AGENTS.md" pointer',
      };
    }
    case 'only-agents': {
      if (!claudeEnabled) return none;
      return {
        writes: [{ file: 'CLAUDE.md', content: pointerText(), backupFirst: claudeExists }],
        open: 'AGENTS.md',
        summary: 'create CLAUDE.md as a one-line "@AGENTS.md" pointer',
      };
    }
    case 'diverged': {
      const p = syncPointerPlan();
      return {
        writes: [{ file: p.file, content: p.content, backupFirst: true }],
        open: 'AGENTS.md',
        summary: 're-point CLAUDE.md at "@AGENTS.md" (your current CLAUDE.md is backed up first)',
      };
    }
    case 'in-sync':
    case 'n/a':
    default:
      return none;
  }
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
  chipState,
  syncPointerPlan,
  oneClickPlan,
};
