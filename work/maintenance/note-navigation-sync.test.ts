import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncNavigation } from './note-navigation-sync.ts';

function fixture() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'thehive-navigation-'));
  const put = (rel: string, text: string) => { const p = path.join(vault, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
  put('20_Wissen/Wissensindex.md', '---\ntyp: wissen\nstatus: aktiv\n---\n\n# Wissensindex\n\nManuell erhaltener Text.\n');
  put('20_Wissen/Neu.md', '---\ntyp: wissen\nstatus: aktiv\n---\n\n# Neue Erkenntnis\n\nGepruefter Inhalt.\n');
  const writes: any[] = [];
  const writer = async (_vault: string, op: any) => {
    writes.push(op); const p = path.join(vault, op.path);
    if (op.kind === 'create_note') put(op.path, '---\ntyp: wissen\n---\n\n' + op.content);
    else fs.appendFileSync(p, '\n\n' + op.content.trim() + '\n');
    return { done: true, applied: 1, results: [{ write_id: 'test-' + writes.length, appended: op.kind === 'append_note', created: op.kind === 'create_note' }] };
  };
  return { vault, put, writes, writer, read: (rel: string) => fs.readFileSync(path.join(vault, rel), 'utf8') };
}

test('preview plans ordinary notes in their index without writing', async () => {
  const f = fixture(); const before = f.read('20_Wissen/Wissensindex.md');
  const result = await syncNavigation({ vault: f.vault, preview: true, writer: f.writer });
  expect(result.status).toBe('preview_only');
  expect(result.operations.some((op: any) => op.path === '20_Wissen/Wissensindex.md' && op.content.includes('[[20_Wissen/Neu|'))).toBe(true);
  expect(f.writes).toHaveLength(0); expect(f.read('20_Wissen/Wissensindex.md')).toBe(before);
});

test('new notes are included automatically; successful rerun performs no writes', async () => {
  const f = fixture(); await syncNavigation({ vault: f.vault, writer: f.writer });
  const n = f.writes.length; const before = f.read('20_Wissen/Wissensindex.md');
  const result = await syncNavigation({ vault: f.vault, writer: f.writer });
  expect(result.status).toBe('unchanged'); expect(f.writes).toHaveLength(n);
  expect(before).toContain('Manuell erhaltener Text.');
  expect(before.match(/\[\[20_Wissen\/Neu\|/g)).toHaveLength(1);
  f.put('20_Wissen/Spaeter.md', '# Spaetere Erkenntnis\n');
  await syncNavigation({ vault: f.vault, writer: f.writer });
  expect(f.read('20_Wissen/Wissensindex.md')).toContain('[[20_Wissen/Spaeter|');
});

test('native explicit references use the fach pool despite backup title collision', async () => {
  const f = fixture();
  f.put('10_Projekte/TheHive.md', '---\ntitle: TheHive\n---\n\n# TheHive\n');
  f.put('20_Wissen/Bezug.md', '# Bezug\n\nDiese Erkenntnis betrifft TheHive.\n');
  f.put('work/backups/TheHive.md', '---\ntitle: TheHive\n---\n\n# TheHive\n');
  const result = await syncNavigation({ vault: f.vault, preview: true });
  const op = result.operations.find((op: any) => op.path === '20_Wissen/Bezug.md');
  expect(op?.content).toContain('[[10_Projekte/TheHive]]');
  expect(result.operations.some((op: any) => op.path.startsWith('work/'))).toBe(false);
});

test('existing short wikilinks are not duplicated; generated notes and test records are not rewritten', async () => {
  const f = fixture(); f.put('20_Wissen/Wissensindex.md', '# Index\n\n- [[Neu]]\n');
  f.put('10_Projekte/Tool-Quellenansicht.md', '---\ngenerated_by: thehive-project-knowledge-v1\n---\n\n# Tool\n\nNeue Erkenntnis\n');
  f.put('20_Wissen/Synthetisch.md', '---\nstatus: test\n---\n\n# Synthetisch\n');
  const result = await syncNavigation({ vault: f.vault, preview: true });
  expect(result.operations.some((op: any) => op.path.endsWith('Quellenansicht.md'))).toBe(false);
  expect(result.operations.some((op: any) => op.path === '20_Wissen/Wissensindex.md' && op.content?.includes('[[20_Wissen/Neu|'))).toBe(false);
  expect(result.operations.some((op: any) => op.path !== '20_Wissen/Vaultindex.md' && op.content?.includes('[[20_Wissen/Synthetisch|'))).toBe(false);
});

test('staged writes are failures and never followed by a fallback write', async () => {
  const f = fixture(); let calls = 0;
  await expect(syncNavigation({ vault: f.vault, writer: async () => { calls++; return { done: true, applied: 0, results: [{ staged: true }] }; } })).rejects.toThrow();
  expect(calls).toBe(1); expect(f.read('20_Wissen/Wissensindex.md')).not.toContain('[[20_Wissen/Neu');
});

test('readback failure is reported; an audit receipt alone is insufficient', async () => {
  const f = fixture();
  await expect(syncNavigation({ vault: f.vault, writer: async () => ({ done: true, applied: 1, results: [{ write_id: 'receipt-only' }] }) })).rejects.toThrow(/readback/i);
});

test('changed sources abort before writing', async () => {
  const f = fixture();
  await expect(syncNavigation({ vault: f.vault, writer: f.writer, beforeWrite: () => f.put('20_Wissen/Neu.md', '# Fremdaenderung\n') })).rejects.toThrow(/changed/i);
  expect(f.writes).toHaveLength(0);
});

test('a junction to another directory is rejected without traversing or writing it', async () => {
  const f = fixture(); const external = fixture();
  fs.symlinkSync(path.join(external.vault, '20_Wissen'), path.join(f.vault, '20_Wissen', 'Extern'), process.platform === 'win32' ? 'junction' : 'dir');
  await expect(syncNavigation({ vault: f.vault, preview: true })).rejects.toThrow(/link|reparse/i);
});

test('a generated index fails closed before any write', async () => {
  const f = fixture(); f.put('20_Wissen/Wissensindex.md', '---\ngenerated_by: other-owner\n---\n\n# Index\n');
  await expect(syncNavigation({ vault: f.vault, writer: f.writer })).rejects.toThrow(/protected.*index/i);
  expect(f.writes).toHaveLength(0);
});

test('lossy note metadata remains protected and visible while safe inbound links are allowed', async () => {
  const f = fixture(); f.put('10_Projekte/Defekt.md', '---\n---\n\n---\n---\n\n# Defekte Metadaten\n\nNeue Erkenntnis\n');
  const before = f.read('10_Projekte/Defekt.md');
  const result = await syncNavigation({ vault: f.vault, writer: f.writer });
  expect(result.status).toBe('partial');
  expect(result.blocked.some((b: any) => b.path === '10_Projekte/Defekt.md')).toBe(true);
  expect(f.read('10_Projekte/Defekt.md')).toBe(before);
  expect(f.read('10_Projekte/Projektindex.md')).toContain('[[10_Projekte/Defekt|');
});

test('a concurrent navigation pass cannot append duplicates', async () => {
  const f = fixture(); let release: any;
  const entered = new Promise<void>(resolve => { release = resolve; });
  let finish: any; const hold = new Promise<void>(resolve => { finish = resolve; });
  const first = syncNavigation({ vault: f.vault, writer: async (...args: any[]) => { release(); await hold; return f.writer(args[0], args[1]); } });
  await entered;
  try { await expect(syncNavigation({ vault: f.vault, writer: f.writer })).rejects.toThrow(/locked/i); }
  finally { finish(); await first; }
});

test('whole-vault index covers existing protected, generated, historical and root notes without altering originals', async () => {
  const f = fixture();
  const additional = [
    '00_System/Gedaechtnis-Regeln.md', 'Brain/active.md', 'Brain/inbox/sig-alt.md',
    'Brain/log/2026-10-27.md', 'docs/Anleitung.md', 'AGENTS.md', '2026-10-26.md',
    'work/handoff/Projekt/current.md', 'work/backups/Original.md', 'work/verification/Pruefung.md',
    'graphify-out/GRAPH_REPORT.md',
  ];
  for (const rel of additional) f.put(rel, '# Original\n\nGeschuetzter Originalinhalt.\n');
  f.put('.git/Verwaltung.md', '# Intern\n');
  f.put('Brain/.snapshots/Intern.md', '# Snapshot\n');
  const originals = additional.map(rel => [rel, f.read(rel)]);
  const result = await syncNavigation({ vault: f.vault, writer: f.writer });
  const index = f.read('20_Wissen/Vaultindex.md');
  for (const rel of additional) expect(index).toContain('[[' + rel.slice(0, -3) + '|');
  expect(index).not.toContain('.git/Verwaltung'); expect(index).not.toContain('.snapshots/Intern');
  expect(f.read('20_Wissen/Wissensindex.md')).toContain('[[20_Wissen/Vaultindex|');
  expect(additional.map(rel => [rel, f.read(rel)])).toEqual(originals);
  expect(result.written.every((row: any) => row.path.startsWith('20_Wissen/'))).toBe(true);
  expect(result.coverage.markdown_files).toBe(additional.length + 3);
  const writes = f.writes.length;
  await syncNavigation({ vault: f.vault, writer: f.writer });
  expect(f.writes).toHaveLength(writes);
  f.put('Brain/retired/ret-neu.md', '# Historische Regel\n');
  await syncNavigation({ vault: f.vault, writer: f.writer });
  expect(f.read('20_Wissen/Vaultindex.md')).toContain('[[Brain/retired/ret-neu|');
});

test('backup copies are listed but never enter the explicit-reference pool', async () => {
  const f = fixture(); f.put('work/backups/Kopie.md', '# Neue Erkenntnis\n\nNeue Erkenntnis\n');
  const r = await syncNavigation({ vault: f.vault, preview: true });
  expect(r.operations.find((op: any) => op.path === '20_Wissen/Vaultindex.md')?.content).toContain('[[work/backups/Kopie|');
  expect(r.operations.some((op: any) => op.path.startsWith('work/'))).toBe(false);
  expect(r.operations.some((op: any) => op.path !== '20_Wissen/Vaultindex.md' && op.content.includes('[[work/backups/Kopie'))).toBe(false);
});

test('Markdown link fallback covers filenames unsupported by Wikilinks and stays idempotent', async () => {
  const f = fixture(); f.put('docs/Ein [Test] #1.md', '# Test\n');
  f.put('docs/Ein (Test) #2.md', '# Zweiter Test\n');
  await syncNavigation({ vault: f.vault, writer: f.writer });
  expect(f.read('20_Wissen/Vaultindex.md')).toContain('docs/Ein%20%5BTest%5D%20%231.md');
  expect(f.read('20_Wissen/Vaultindex.md')).toContain('docs/Ein%20%28Test%29%20%232.md');
  const n = f.writes.length; await syncNavigation({ vault: f.vault, writer: f.writer });
  expect(f.writes).toHaveLength(n);
});

test('literal percent sequences in wikilink filenames are not URL decoded', async () => {
  const f = fixture(); f.put('docs/A%20B.md', '# Literal percent\n');
  await syncNavigation({ vault: f.vault, writer: f.writer });
  const before = f.read('20_Wissen/Vaultindex.md'); const n = f.writes.length;
  await syncNavigation({ vault: f.vault, writer: f.writer });
  expect(f.read('20_Wissen/Vaultindex.md')).toBe(before);
  expect(f.writes).toHaveLength(n);
});
