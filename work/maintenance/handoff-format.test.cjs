'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { renderMarkdown, parseMarkdown } = require('./handoff-format.cjs');
const record = {
  format_version: 1, markdown_schema_version: 1, checkpoint_id: 'a'.repeat(64),
  project_id: 'TheHive', session_id: 'session-26', parent_checkpoint_id: null,
  created_at: '2026-10-26T12:00:00.000Z',
  recent_changes: { tasks: { done: { status: 'verified', evidence: 'proof.json' } } },
  state: { goal: 'Gezielte Fortsetzung', status: 'verified', last_section: 'A10',
    decisions: { preserve: { text: 'Vorhandenen Vault erhalten', source: 'Auftrag A10' } },
    tasks: { done: { text: 'SCHEMA_ERLEDIGT', status: 'verified', evidence: 'proof.json' },
      trial: { text: 'NUR_GETESTET', status: 'tested', evidence: 'trial.json' },
      unsupported: { text: 'OHNE_NACHWEIS', status: 'verified' } },
    next_step: { text: 'Offenen Fortsetzungsschritt ausführen', success_criterion: 'Neuer fachlicher Beleg' },
    sources: { first: { path: 'C:\\TheHive\\auftrag.md', reference: 'turn-1' },
      second: { path: 'C:\\TheHive\\auftrag.md', uri: 'https://example.org/reference', session_ref: 'session-original' } },
    authorizations: { current: 'Nur bestehender Auftrag' }, risks: { outside: 'Kein Cloudexport' },
    do_not_repeat: { baseline: 'Bestandene Basistests' } }
};
const sample = `---
schema_version: 1
project_id: TheHive
scope: project
session_id: actual-session-or-explicitly-unknown
checkpoint_id: thehive-cp-000012
parent_checkpoint_id: thehive-cp-000011
updated_at: "2026-10-26T11:00:00+01:00"
status: in_progress
source_refs:
  - "actual-session-source-reference"
---

# STATUS
Arbeitsstand.
# DECISIONS
Entscheidung mit Quelle.
# RECENT_CHANGES
Neue Änderung.
# COMPLETED
Belegte Aufgabe.
# NEXT_ACTION
Nächster Schritt mit Erfolgskriterium.
# BLOCKERS
Keine dokumentiert.
# REFERENCES
Originalquelle.
`;

// Break caught: new writer omits metadata/sections or drops preserved state fields.
test('renders and validates seven sections, externally identified metadata and the full preserved state', () => {
  const markdown = renderMarkdown(record);
  const parsed = parseMarkdown(markdown, record);
  assert.equal(parsed.metadata.schema_version, 1);
  assert.equal(parsed.metadata.project_id, 'TheHive');
  assert.equal(parsed.metadata.parent_checkpoint_id, null);
  assert.equal(parsed.metadata.updated_at, '2026-10-26T12:00:00.000Z');
  assert.equal(parsed.metadata.scope, 'project');
  assert.deepEqual(parsed.state, record.state);
  assert.match(parsed.sections.DECISIONS, /Vorhandenen Vault erhalten/);
  assert.match(parsed.sections.NEXT_ACTION, /Offenen Fortsetzungsschritt ausführen/);
  assert.match(parsed.sections.NEXT_ACTION, /Neuer fachlicher Beleg/);
  assert.equal(Object.keys(parsed.sections).filter(k => k !== 'DATA').length, 7);
  assert.equal(Object.hasOwn(parsed.metadata, 'sha256'), false);
});

test('accepts documented plain YAML values, quoted timezone timestamp and block source references', () => {
  const parsed = parseMarkdown(sample);
  assert.equal(parsed.metadata.checkpoint_id, 'thehive-cp-000012');
  assert.equal(parsed.metadata.updated_at, '2026-10-26T11:00:00+01:00');
  assert.deepEqual(parsed.metadata.source_refs, ['actual-session-source-reference']);
});

// Break caught: verified-without-proof or merely tested tasks claimed completed.
test('COMPLETED contains only verified tasks with evidence and recent changes use stable changed-field keys', () => {
  const parsed = parseMarkdown(renderMarkdown(record));
  assert.match(parsed.sections.COMPLETED, /SCHEMA_ERLEDIGT/);
  assert.match(parsed.sections.COMPLETED, /proof.json/);
  assert.doesNotMatch(parsed.sections.COMPLETED, /NUR_GETESTET|OHNE_NACHWEIS/);
  assert.match(parsed.sections.RECENT_CHANGES, /tasks/);
  assert.match(parsed.sections.RECENT_CHANGES, /done/);
  assert.doesNotMatch(parsed.sections.RECENT_CHANGES, /NUR_GETESTET|Vorhandenen Vault erhalten/);
});

test('retains evidenced completion snapshots while marking a deliberately reopened task as historical', () => {
  const reopened = JSON.parse(JSON.stringify(record));
  reopened.state.completed = { done: { text: 'HISTORISCH_ERLEDIGT', evidence: 'prior-proof.json' } };
  reopened.state.tasks.done = { text: 'Explizit wieder geöffnet', status: 'planned' };
  reopened.state.blockers = { missing: { text: 'FEHLENDE_FREIGABE', status: 'open', source: 'Turn 8' } };
  const parsed = parseMarkdown(renderMarkdown(reopened), reopened);
  assert.match(parsed.sections.COMPLETED, /HISTORISCH_ERLEDIGT/);
  assert.match(parsed.sections.COMPLETED, /prior-proof.json/);
  assert.match(parsed.sections.COMPLETED, /historisch/i);
  assert.match(parsed.sections.BLOCKERS, /FEHLENDE_FREIGABE/);
});

test('source references are deduplicated and deterministic output is independent of object insertion order', () => {
  const markdown = renderMarkdown(record), parsed = parseMarkdown(markdown);
  assert.deepEqual(parsed.metadata.source_refs, ['C:\\TheHive\\auftrag.md', 'https://example.org/reference', 'session-original', 'turn-1']);
  const reordered = JSON.parse(JSON.stringify(record));
  reordered.state.sources = { second: record.state.sources.second, first: record.state.sources.first };
  reordered.state.tasks = { unsupported: record.state.tasks.unsupported, trial: record.state.tasks.trial, done: record.state.tasks.done };
  assert.equal(renderMarkdown(reordered), markdown);
});

// Break caught: a literal heading in a fenced source treated as required structure.
test('requires each heading exactly once outside fences while ignoring fenced heading examples', () => {
  const withFence = sample + '\n```markdown\n# STATUS\n# NEXT_ACTION\n```\n';
  assert.doesNotThrow(() => parseMarkdown(withFence));
  assert.throws(() => parseMarkdown(sample.replace('# NEXT_ACTION', '# EXTRA')), /NEXT_ACTION/);
  assert.throws(() => parseMarkdown(sample + '\n# STATUS\nDuplicate\n'), /duplicate|exactly once/i);
  assert.throws(() => parseMarkdown(sample + '\n```\nUnclosed\n'), /fence/i);
});

test('rejects missing, duplicate, unknown, unsafe or wrongly typed frontmatter and invalid version links', () => {
  const changes = [
    sample.replace('schema_version: 1', 'schema_version: 2'),
    sample.replace('project_id: TheHive', 'project_id: true'),
    sample.replace('scope: project', 'scope: global'),
    sample.replace('session_id: actual-session-or-explicitly-unknown', 'session_id: []'),
    sample.replace('source_refs:\n  - "actual-session-source-reference"', 'source_refs: {bad: value}'),
    sample.replace('project_id: TheHive', 'project_id: TheHive\nproject_id: Other'),
    sample.replace('project_id: TheHive', 'project_id: !unsafe TheHive'),
    sample.replace('project_id: TheHive', 'project_id: &alias TheHive'),
    sample.replace('project_id: TheHive', 'project_id: *alias'),
    sample.replace('scope: project', 'scope: project\nsha256: made-up'),
    sample.replace('updated_at: "2026-10-26T11:00:00+01:00"', 'updated_at: "2026-02-30T11:00:00Z"'),
    sample.replace('parent_checkpoint_id: thehive-cp-000011', 'parent_checkpoint_id: thehive-cp-000012'),
    sample.replace('project_id: TheHive\n', '')
  ];
  for (const malformed of changes) assert.throws(() => parseMarkdown(malformed), /schema|metadata|frontmatter|YAML|scope|parent|timestamp/i);
});

test('expected record rejects altered metadata, rendered prose or structured data', () => {
  const markdown = renderMarkdown(record);
  assert.throws(() => parseMarkdown(markdown.replace('project_id: "TheHive"', 'project_id: "Other"'), record), /metadata|record|match/i);
  assert.throws(() => parseMarkdown(markdown.replace('Gezielte Fortsetzung', 'Manipulierter Stand'), record), /content|record|match/i);
  assert.throws(() => parseMarkdown(markdown.replace('Nur bestehender Auftrag', 'Ausgeweitete Befugnis'), record), /content|record|match/i);
});

test('keeps additional section names as ordinary own keys without changing section lookup', () => {
  const parsed = parseMarkdown(sample + '\n# __proto__\nOpaque extra text\n');
  assert.equal(Object.hasOwn(parsed.sections, '__proto__'), true);
  assert.equal(parsed.sections.__proto__, 'Opaque extra text');
  assert.equal(parsed.sections.STATUS, 'Arbeitsstand.');
});

test('rejects malformed YAML separators and unsupported record schema markers', () => {
  assert.throws(() => parseMarkdown(sample.replace('schema_version: 1', 'schema_version:1')), /YAML|frontmatter|metadata/i);
  assert.throws(() => renderMarkdown({ ...record, markdown_schema_version: 2 }), /schema/i);
});
