'use strict';

/**
 * Minimal YAML-frontmatter reader for the department agent .md files.
 * We only need flat `key: value` pairs from the leading `--- ... ---` block,
 * so this deliberately does NOT pull in a YAML dependency.
 */
function parseFrontmatter(text) {
  const norm = String(text).replace(/\r\n/g, '\n');
  if (!norm.startsWith('---\n')) return { attrs: {}, body: norm };
  const end = norm.indexOf('\n---', 4);
  if (end === -1) return { attrs: {}, body: norm };
  const raw = norm.slice(4, end);
  const body = norm.slice(end + 4).replace(/^\n/, '');
  const attrs = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    attrs[m[1]] = val;
  }
  return { attrs, body };
}

/**
 * Turn a directory listing of agent .md files into department records.
 * `files` is an array of { file, text }.
 */
function toDepartments(files) {
  const out = [];
  for (const { file, text } of files) {
    const base = file.replace(/\\/g, '/').split('/').pop();
    if (base.toLowerCase() === 'changelog.md') continue;
    const { attrs } = parseFrontmatter(text);
    if (!attrs.name) continue;
    out.push({
      name: attrs.name,
      model: attrs.model || 'unknown',
      description: attrs.description || '',
      file: base,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

module.exports = { parseFrontmatter, toDepartments };
