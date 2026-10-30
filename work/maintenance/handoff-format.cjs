'use strict';
// A10 format contract. Deliberately bounded YAML subset: known flat keys,
// string/number/null scalars, JSON string arrays or two-space block source_refs.
// No YAML tags, anchors, aliases, merge keys, flow maps or implicit object types.
// The writer emits JSON-quoted scalar values (valid YAML) and one JSON list.
const HEADINGS = ['STATUS', 'DECISIONS', 'RECENT_CHANGES', 'COMPLETED', 'NEXT_ACTION', 'BLOCKERS', 'REFERENCES'];
const META = ['schema_version', 'project_id', 'scope', 'session_id', 'checkpoint_id',
  'parent_checkpoint_id', 'updated_at', 'status', 'source_refs'];
const STATUSES = new Set(['planned', 'implemented', 'tested', 'verified', 'blocked', 'in_progress']);
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (isObject(value)) return Object.fromEntries(Object.keys(value).sort().map(k => [k, ordered(value[k])]));
  return value;
}
const json = value => JSON.stringify(ordered(value));
const inline = value => String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
function evidence(value) {
  return typeof value === 'string' ? value.trim().length > 0 :
    Array.isArray(value) ? value.length > 0 : isObject(value) && Object.keys(value).length > 0;
}
function describe(value) {
  if (!isObject(value)) return inline(typeof value === 'string' ? value : json(value));
  const text = value.text || value.summary || value.description;
  if (!text) return inline(json(value));
  const details = ['status', 'scope', 'reason', 'source', 'evidence'].filter(k => value[k] !== undefined)
    .map(k => `${k}: ${typeof value[k] === 'string' ? inline(value[k]) : json(value[k])}`);
  return inline(text) + (details.length ? ` (${details.join('; ')})` : '');
}
function entries(map, empty) {
  const lines = Object.keys(map || {}).sort().map(k => `- ${inline(k)}: ${describe(map[k])}`);
  return lines.length ? lines.join('\n') : empty;
}
function sourceRefs(record) {
  const refs = [];
  for (const source of Object.values(record.state.sources || {})) {
    if (typeof source === 'string' && source.trim()) refs.push(source.trim());
    if (isObject(source)) for (const k of ['path', 'reference', 'uri', 'session_ref']) {
      if (typeof source[k] === 'string' && source[k].trim()) refs.push(source[k].trim());
    }
  }
  return [...new Set(refs)].sort();
}
function validTimestamp(value) {
  if (typeof value !== 'string') return false;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/);
  if (!m || !Number.isFinite(Date.parse(value))) return false;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return mo >= 1 && mo <= 12 && d >= 1 && d <= days[mo - 1] && h <= 23 && mi <= 59 && s <= 59;
}
function validateMetadata(meta) {
  if (Object.keys(meta).length !== META.length || META.some(k => !Object.hasOwn(meta, k))) throw Error('Metadata schema: all required fields must occur once');
  if (meta.schema_version !== 1) throw Error('Metadata schema_version must be 1');
  if (meta.scope !== 'project') throw Error('Metadata scope must be project');
  for (const key of ['project_id', 'session_id']) {
    if (typeof meta[key] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(meta[key]) ||
        /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(meta[key])) throw Error(`Metadata invalid ${key}`);
  }
  for (const key of ['checkpoint_id', 'parent_checkpoint_id']) {
    if (key === 'parent_checkpoint_id' && meta[key] === null) continue;
    if (typeof meta[key] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(meta[key])) throw Error(`Metadata invalid ${key}`);
  }
  if (meta.parent_checkpoint_id === meta.checkpoint_id) throw Error('Metadata parent cannot equal current checkpoint');
  if (!validTimestamp(meta.updated_at)) throw Error('Metadata timestamp requires a real ISO-8601 date and timezone');
  if (typeof meta.status !== 'string' || !STATUSES.has(meta.status)) throw Error('Metadata invalid status');
  if (!Array.isArray(meta.source_refs) || meta.source_refs.some(v => typeof v !== 'string' || !v.trim() || /[\r\n\0]/.test(v)) ||
      new Set(meta.source_refs).size !== meta.source_refs.length) throw Error('Metadata source_refs must be a deduplicated string list');
}
function metadata(record) {
  const meta = { schema_version: 1, project_id: record.project_id, scope: 'project', session_id: record.session_id,
    checkpoint_id: record.checkpoint_id, parent_checkpoint_id: record.parent_checkpoint_id,
    updated_at: record.created_at, status: record.state.status, source_refs: sourceRefs(record) };
  validateMetadata(meta); return meta;
}
function renderMarkdown(record) {
  if (!isObject(record) || !isObject(record.state)) throw Error('Record/state required for Markdown schema');
  if (record.markdown_schema_version !== undefined && record.markdown_schema_version !== 1) throw Error('Unsupported record Markdown schema version');
  const state = record.state, meta = metadata(record);
  const completed = {};
  const snapshots = isObject(state.completed) ? state.completed : null;
  for (const [k, task] of Object.entries(snapshots || state.tasks || {})) {
    if (!isObject(task) || !evidence(task.evidence) || (!snapshots && task.status !== 'verified')) continue;
    const current = state.tasks?.[k];
    completed[k] = snapshots && current && current.status !== 'verified' ? {
      ...task, text: `${task.text || k} [historisch abgeschlossen; aktuell ${inline(current.status)}]`,
    } : task;
  }
  const blockers = { ...(state.blockers || {}) };
  for (const [k, task] of Object.entries(state.tasks || {})) if (task.status === 'blocked') blockers[`task:${k}`] = task;
  const sections = {
    STATUS: `- Ziel: ${inline(state.goal)}\n- Status: ${inline(state.status)}\n- Zuletzt bearbeitet: ${inline(state.last_section)}`,
    DECISIONS: entries(state.decisions, 'Keine Entscheidungen im Checkpoint erfasst.') +
      (state.decision_events && Object.keys(state.decision_events).length ? '\n\nBelegte Entscheidungsänderungen:\n' + entries(state.decision_events, '') : ''),
    RECENT_CHANGES: entries(record.recent_changes, 'Keine Änderungen seit dem Elterncheckpoint erfasst.'),
    COMPLETED: entries(completed, 'Keine nachgewiesenen Abschlüsse im Checkpoint erfasst.'),
    NEXT_ACTION: `- Schritt: ${inline((state.chat_tasks?.[record.session_id]?.next_step || state.next_step)?.text)}\n- Erfolgskriterium: ${inline((state.chat_tasks?.[record.session_id]?.next_step || state.next_step)?.success_criterion)}`,
    BLOCKERS: entries(blockers, 'Keine Blocker im Checkpoint erfasst.') +
      (state.risks && Object.keys(state.risks).length ? '\n\nDokumentierte Risiken:\n' + entries(state.risks, '') : ''),
    REFERENCES: (meta.source_refs.length ? meta.source_refs.map(v => `- ${inline(v)}`).join('\n') : 'Keine Originalquellen im Checkpoint erfasst.') +
      (record.parent_checkpoint_id ? `\n- Elterncheckpoint: ${record.parent_checkpoint_id}` : '') +
      (record.parent_reference?.file ? `\n- Elternquelle: ${inline(record.parent_reference.file)} (SHA-256: ${inline(record.parent_reference.sha256)})` : ''),
  };
  return '---\n' + META.map(k => `${k}: ${JSON.stringify(meta[k])}`).join('\n') + '\n---\n\n' +
    HEADINGS.map(k => `# ${k}\n\n${sections[k]}\n`).join('\n') +
    '\n# DATA\n\n```json\n' + JSON.stringify(ordered(state), null, 2) + '\n```\n';
}
function scalar(raw) {
  const value = raw.trim();
  if (value.startsWith('"')) {
    let parsed; try { parsed = JSON.parse(value); } catch { throw Error('Invalid quoted YAML string'); }
    if (typeof parsed !== 'string') throw Error('YAML string required');
    return parsed;
  }
  if (value.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(value)) throw Error('Invalid single-quoted YAML string');
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value === 'null') return null;
  if (!value || /^[!&*|>{}\[\],]/.test(value) || /^(true|false|yes|no|on|off|~)$/i.test(value) ||
      /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value) || /:\s|\s#/.test(value)) throw Error('Unsupported YAML scalar type or syntax');
  return value;
}
function parseFrontmatter(lines) {
  const meta = {}, seen = new Set(); let list = false;
  for (const line of lines) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (/^\s/.test(line)) {
      const item = line.match(/^ {2}- (.+)$/);
      if (!list || !item) throw Error('Unsupported YAML indentation or list');
      const value = scalar(item[1]);
      if (typeof value !== 'string') throw Error('YAML source_refs requires strings');
      meta.source_refs.push(value); continue;
    }
    const pair = line.match(/^([a-z_]+):(?:[ \t]+(.*))?$/);
    if (!pair || !META.includes(pair[1]) || seen.has(pair[1])) throw Error('Unknown or duplicate frontmatter metadata key');
    const [, key, raw = ''] = pair; seen.add(key); list = false;
    if (key === 'source_refs') {
      if (!raw.trim()) { meta[key] = []; list = true; }
      else {
        try { meta[key] = JSON.parse(raw); } catch { throw Error('YAML source_refs supports a JSON string array or two-space block list'); }
      }
    } else if (key === 'schema_version') {
      if (!/^\d+$/.test(raw)) throw Error('Metadata schema_version requires an integer');
      meta[key] = Number(raw);
    } else meta[key] = scalar(raw);
  }
  validateMetadata(meta); return meta;
}
function parseMarkdown(text, expectedRecord) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 1024 * 1024 || text.includes('\0')) throw Error('Markdown schema requires text up to 1 MiB');
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0] !== '---') throw Error('YAML frontmatter required');
  const end = lines.indexOf('---', 1);
  if (end < 0) throw Error('Unclosed YAML frontmatter');
  const meta = parseFrontmatter(lines.slice(1, end)), sections = Object.create(null);
  let fence = null, current = null;
  for (const line of lines.slice(end + 1)) {
    const boundary = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (boundary) {
      if (!fence) fence = { char: boundary[1][0], length: boundary[1].length };
      else if (boundary[1][0] === fence.char && boundary[1].length >= fence.length && !boundary[2].trim()) fence = null;
      if (current) sections[current].push(line);
      continue;
    }
    const heading = !fence && line.match(/^# (.+?)\s*$/);
    if (heading) {
      current = heading[1];
      if (Object.hasOwn(sections, current)) throw Error(`Heading ${current} must occur exactly once; duplicate found`);
      sections[current] = [];
    } else if (current) sections[current].push(line);
  }
  if (fence) throw Error('Unclosed Markdown fence');
  for (const heading of HEADINGS) if (!Object.hasOwn(sections, heading)) throw Error(`Required heading ${heading} must occur exactly once`);
  for (const key of Object.keys(sections)) sections[key] = sections[key].join('\n').trim();
  let state;
  if (Object.hasOwn(sections, 'DATA')) {
    const data = sections.DATA.match(/^```json\r?\n([\s\S]*?)\r?\n```$/);
    if (!data) throw Error('DATA must contain one JSON state fence');
    try { state = JSON.parse(data[1]); } catch { throw Error('Invalid DATA JSON state'); }
    if (!isObject(state)) throw Error('DATA JSON state must be an object');
  }
  if (expectedRecord) {
    if (json(meta) !== json(metadata(expectedRecord))) throw Error('Markdown metadata does not match expected record');
    if (text !== renderMarkdown(expectedRecord)) throw Error('Markdown content does not match expected record');
  }
  return { metadata: meta, sections, ...(state ? { state } : {}) };
}
module.exports = { renderMarkdown, parseMarkdown };
