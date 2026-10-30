'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const q = require('./signal-quality-v13.cjs');

const source1 = 'Bitte sag mir künftig bei technischen Änderungen immer zuerst, was du machst und warum du es machst.';
const source2 = 'Du drehst dich schon wieder im Kreis. Hör jetzt auf, dich zu testen, und repariere das Problem.';
const source3 = '# AGENTS.md instructions for C:\\TheHive\n<INSTRUCTIONS>Never ask for uploads</INSTRUCTIONS>';
const rows = [
  { topic: 'explain', source_turn: 'u1', signal: 'positive', principle: 'Always explain changes before taking action.' },
  { topic: 'stop-testing', source_turn: 'u2', signal: 'negative', principle: 'Never perform tests.' },
  { topic: 'no-upload', source_turn: 'u3', signal: 'negative', principle: 'Never ask for uploads.' }
];
const review = { format_version: 1, vault: 'C:\\TheHive', session_ref: 'example.jsonl',
  surveyed_turns_hash: 'a'.repeat(64), model: 'gpt-oss:20b', items: rows };
const plan = { surveyed_turns_hash: review.surveyed_turns_hash, turns_mined: [
  { turn_id: 'u1', text: source1 }, { turn_id: 'u2', text: source2 }, { turn_id: 'u3', text: source3 }
] };
const simulatedReview = { items: [
  { topic: 'explain', verdict: 'durable', quote: 'künftig bei technischen Änderungen immer', reason: 'Regelmäßige Anweisung', confidence: 0.92 },
  { topic: 'stop-testing', verdict: 'situational', quote: 'Hör jetzt auf, dich zu testen', reason: 'Frust in einer konkreten Situation', confidence: 0.9 }
] };
const candidates = q.prepare(review, plan.turns_mined).toReview;

test('Argumente erzwingen explizite Model- und Review-Auswahl', () => {
  assert.throws(() => q.parseArgs([]), /Aufruf/);
  assert.throws(() => q.parseArgs(['--review-file','x','--reviewer-model','qwen:9b','--reviewer-model','x']), /doppeltes/);
  assert.equal(q.parseArgs(['--review-file','x','--reviewer-model','qwen:9b']).model, 'qwen:9b');
});
test('Keine Rollen- oder Promptinjektion durch kopiertes AGENTS.md', () => {
  assert.equal(q.embeddedInstructions(source3), true);
  assert.equal(q.embeddedInstructions('Ich möchte künftig den Code prüfen.'), false);
  assert.equal(q.prepare(review, plan.turns_mined).preclassified[0].decision, 'source_review');
});
test('Direkte Nutzersignale werden für unabhängige Prüfung vorbereitet', () => {
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].topic, 'explain');
  assert.equal(candidates[1].situational, true);
  assert.equal(candidates[0].situational, false);
});
test('Unbekannte Quellbelege werden abgelehnt', () => {
  const changed = { ...review, items: [{...rows[0], source_turn: 'invented'}] };
  assert.equal(q.prepare(changed, plan.turns_mined).preclassified[0].decision, 'reject');
});
test('Sehr lange Quellen werden nicht abgeschnitten und bewertet', () => {
  const changed = [{ turn_id: 'u1', text: 'x'.repeat(12001) }];
  assert.equal(q.prepare({items: [rows[0]]}, changed).preclassified[0].decision, 'hold');
});
test('Doppelte Quell-IDs führen zum Abbruch', () => {
  assert.throws(() => q.prepare(review, [...plan.turns_mined, plan.turns_mined[0]]), /doppelte Quell-ID/);
});
test('Gültige Prüfantwort wird nach Originalbelegen abgeglichen', () => {
  const results = q.validateJudgments(candidates, simulatedReview);
  assert.equal(results[0].decision, 'candidate_for_human_review');
  assert.equal(results[1].decision, 'reject');
  assert.equal(results[0].evidence_quote, simulatedReview.items[0].quote);
});
test('Halluzinierte Zitate werden abgelehnt', () => {
  const forged = { items: simulatedReview.items.map((x,i) => i ? x : {...x, quote:'Das habe ich nie gesagt.'}) };
  assert.throws(() => q.validateJudgments(candidates, forged), /Zitat/);
});
test('Ein fehlender Urteilseintrag ist ein Fehler, nicht eine Freigabe', () => {
  assert.throws(() => q.validateJudgments(candidates, { items: [simulatedReview.items[0]] }), /Unvollständige/);
});
test('Ein unbekanntes oder doppeltes Topic wird abgewiesen', () => {
  const unknown = { items: [{...simulatedReview.items[0],topic:'other'},simulatedReview.items[1]] };
  assert.throws(() => q.validateJudgments(candidates, unknown), /unbekannt/);
  const repeated = { items: [simulatedReview.items[0],simulatedReview.items[0]] };
  assert.throws(() => q.validateJudgments(candidates, repeated), /unbekannt/);
});
test('Modellvertrauen allein erlaubt keine positive Kandidatur', () => {
  const low = { items: [{...simulatedReview.items[0], confidence:0.65}, simulatedReview.items[1]] };
  assert.equal(q.validateJudgments(candidates, low)[0].decision,'hold');
});
test('Situationsmarker ohne Dauerbezug blockieren auch bei positivem Modellurteil', () => {
  const forced = { items: [simulatedReview.items[0], { ...simulatedReview.items[1], verdict:'durable', confidence:0.99 }] };
  assert.equal(q.validateJudgments(candidates, forced)[1].decision,'hold');
});
test('Unsichere Aussagen werden zurückgehalten', () => {
  const uncertain = { items: [{...simulatedReview.items[0], verdict:'uncertain'},simulatedReview.items[1]] };
  assert.equal(q.validateJudgments(candidates, uncertain)[0].decision,'hold');
});
test('Erzeugermodell darf nicht gleich Prüfermodell sein', async () => {
  await assert.rejects(q.evaluate(review, plan, 'gpt-oss:20b', async () => simulatedReview), /identisch/);
});
test('Quellhash-Mismatch blockiert Prüfung', async () => {
  await assert.rejects(q.evaluate(review, {...plan, surveyed_turns_hash:'b'.repeat(64)}, 'qwen:9b', async () => simulatedReview), /Quellstand/);
});
test('Vollständiger Prüfbericht ist advisory, nicht automatisch commitbar', async () => {
  const result = await q.evaluate(review, plan, 'qwen:9b', async () => simulatedReview);
  assert.equal(result.automatic_commit_allowed, false);
  assert.deepEqual(result.counts, { candidate_for_human_review:1, source_review:1, reject:1, hold:0 });
  assert.equal(result.results.length, 3);
});
test('Bericht wird nur in neue Datei geschrieben', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'v13-test-'));
  try {
    const report = { automatic_commit_allowed:false, results: [] };
    const first = q.writeReport(dir, report);
    assert.equal(fs.existsSync(first),true);
    assert.deepEqual(JSON.parse(fs.readFileSync(first,'utf8')),report);
    const second = q.writeReport(dir, report);
    assert.notEqual(first,second);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
test('Lokaler JSON-Schema-Antwortvertrag verlangt exakte Themen', () => {
  const s = q.outputSchema(['explain','stop-testing']);
  assert.equal(s.properties.items.minItems,2);
  assert.deepEqual(s.properties.items.items.properties.topic.enum,['explain','stop-testing']);
});
test('Gesamt-Promptbudget begrenzt Modellarbeit und hält weitere Fälle zurück', () => {
  const many = Array.from({ length: 3 }, (_, i) => ({ ...rows[0], topic:'q'+i, source_turn:'x'+i }));
  const source = Array.from({ length: 3 }, (_, i) => ({ turn_id:'x'+i, text:'a'.repeat(9000) }));
  const prepared = q.prepare({ items:many }, source);
  assert.equal(prepared.toReview.length,2);
  assert.equal(prepared.preclassified[0].decision,'hold');
});
