'use strict';

/**
 * Attachment helpers for the Run view — pure Node, no vscode, no webview.
 * The extension does the dialog / disk work; this module builds the strings and
 * enforces the safety rules, and the sanity test exercises it directly (with a
 * fake fs injected).
 *
 * Two jobs:
 *   1. buildPathInsert()  — turn picked file paths into the exact text that goes
 *      into the Run-view input line (space-joined, quoted iff spaced, never a
 *      newline).
 *   2. writePastedImage() — write clipboard/drag image bytes to a generated file
 *      inside the workspace folder, size-guarded, and hand back the path.
 */

const path = require('path');

// Image MIME subtypes we will trust for a generated filename extension. Anything
// else falls back to .png — the extension is never taken from caller text.
const IMAGE_EXT_BY_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
};

const DEFAULT_ATTACHMENTS_DIR = '.agentyard/tmp';
const DEFAULT_MAX_ATTACHMENT_MB = 10;

function hasNewline(s) {
  return /[\r\n]/.test(s);
}

// Wrap a path in double quotes only when it contains whitespace — that is all
// Claude Code's prompt parser needs to keep a spaced path as one token. No other
// munging, so this behaves identically on win/mac/linux.
function quoteIfSpaced(p) {
  return /\s/.test(p) ? '"' + p + '"' : p;
}

/**
 * @param {string[]|string} paths  file paths (absolute fsPath values)
 * @returns {string}  the text to insert into the input line
 * @throws if any path contains a CR or LF (we never insert a newline)
 */
function buildPathInsert(paths) {
  const list = Array.isArray(paths) ? paths : [paths];
  const out = [];
  for (const raw of list) {
    const p = String(raw == null ? '' : raw);
    if (!p) continue;
    if (hasNewline(p)) {
      throw new Error('attachment path contains a line break — refusing to insert it');
    }
    out.push(quoteIfSpaced(p));
  }
  return out.join(' ');
}

// A filename-safe UTC stamp: 2026-08-29T12-34-56-789Z
function utcStamp(now) {
  const d = now instanceof Date ? now : new Date(now == null ? Date.now() : now);
  return d.toISOString().replace(/[:.]/g, '-');
}

/**
 * Fully generated attachment filename — no caller-supplied or clipboard text
 * ever goes into it, only a fixed prefix, a UTC stamp, and a whitelisted
 * extension.
 */
function pastedImageName(now, mime) {
  const ext = IMAGE_EXT_BY_MIME[String(mime || '').toLowerCase()] || 'png';
  return 'paste-' + utcStamp(now) + '.' + ext;
}

// Resolve <root>/<dir>/<name> and assert it stays strictly inside <root>.
function resolveInsideWorkspace(root, dir, name) {
  if (!root) throw new Error('open a folder to attach files');
  const base = path.resolve(root);
  const target = path.resolve(base, dir || '.', name || '');
  const rel = path.relative(base, target);
  if (rel === '' || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    throw new Error('attachment path escapes the workspace folder');
  }
  return target;
}

function maxAttachmentBytes(maxMB) {
  const mb = typeof maxMB === 'number' && maxMB > 0 ? maxMB : DEFAULT_MAX_ATTACHMENT_MB;
  return Math.floor(mb * 1024 * 1024);
}

function withinSizeLimit(byteLength, maxMB) {
  return byteLength <= maxAttachmentBytes(maxMB);
}

/**
 * Write image/file bytes to a generated path inside the workspace.
 *
 * @param {object} opts
 * @param {string} opts.root    first workspace folder (absolute)
 * @param {string} [opts.dir]   attachments dir, relative to root
 * @param {Buffer|Uint8Array} opts.bytes
 * @param {number} [opts.maxMB]
 * @param {Date|number} [opts.now]
 * @param {string} [opts.mime]  image MIME, only used to pick the file extension
 * @param {object} [io]         fs-shaped { mkdirSync, writeFileSync } (test hook)
 * @returns {string} the absolute path written
 */
function writePastedImage(opts, io) {
  const o = opts || {};
  const fsIo = io || require('fs');
  if (!o.root) throw new Error('open a folder to attach files');
  const bytes = o.bytes;
  const len = bytes && typeof bytes.length === 'number' ? bytes.length : 0;
  if (!len) throw new Error('attachment is empty');
  if (!withinSizeLimit(len, o.maxMB)) {
    const mb = typeof o.maxMB === 'number' && o.maxMB > 0 ? o.maxMB : DEFAULT_MAX_ATTACHMENT_MB;
    throw new Error('attachment is larger than the ' + mb + ' MB limit');
  }
  const target = resolveInsideWorkspace(o.root, o.dir || DEFAULT_ATTACHMENTS_DIR, pastedImageName(o.now, o.mime));
  fsIo.mkdirSync(path.dirname(target), { recursive: true });
  fsIo.writeFileSync(target, bytes);
  return target;
}

/**
 * Clear the attachments dir (used when agentyard.keepAttachments is false). Only
 * ever touches <root>/<dir> — never climbs out, never touches the workspace root
 * itself.
 */
function clearAttachmentsDir(root, dir, io) {
  const fsIo = io || require('fs');
  if (!root || !dir) return false;
  let target;
  try {
    const base = path.resolve(root);
    target = path.resolve(base, dir);
    const rel = path.relative(base, target);
    if (rel === '' || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
      return false;
    }
  } catch (e) {
    return false;
  }
  try {
    fsIo.rmSync(target, { recursive: true, force: true });
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = {
  DEFAULT_ATTACHMENTS_DIR,
  DEFAULT_MAX_ATTACHMENT_MB,
  IMAGE_EXT_BY_MIME,
  buildPathInsert,
  pastedImageName,
  resolveInsideWorkspace,
  maxAttachmentBytes,
  withinSizeLimit,
  writePastedImage,
  clearAttachmentsDir,
};
