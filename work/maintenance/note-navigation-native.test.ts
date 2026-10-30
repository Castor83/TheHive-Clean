import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { syncNavigation } from './note-navigation-sync.ts';

test('native navigation creates and appends with preserved content, exact audit identity and an idle rerun', async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'thehive-navigation-native-'));
  const vault = path.join(temporaryRoot, 'vault');
  const configPath = path.join(temporaryRoot, 'config.yaml');
  const previousConfig = process.env.OPEN_SECOND_BRAIN_CONFIG;
  const previousAgent = process.env.VAULT_AGENT_NAME;
  const core = path.join(os.homedir(), 'projects/open-second-brain/src/core');
  const load = (rel: string) => import(pathToFileURL(path.join(core, rel)).href);
  try {
    fs.writeFileSync(configPath, `vault: ${JSON.stringify(vault.replace(/\\/g, '/'))}\nagent_name: navigation-config-agent\ndevice_id: navigation-test\n`);
    process.env.OPEN_SECOND_BRAIN_CONFIG = configPath;
    process.env.VAULT_AGENT_NAME = 'original-navigation-test-agent';
    const [{ bootstrapBrain }, { formatFrontmatter, parseFrontmatterText }, { listNoteWrites }] = await Promise.all([
      load('brain/init.ts'), load('vault.ts'), load('brain/notes/write-log.ts'),
    ]);
    bootstrapBrain(vault, { configPath });
    const put = (rel: string, meta: any, body: string) => {
      const abs = path.join(vault, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, formatFrontmatter(meta, body));
    };
    const read = (rel: string) => fs.readFileSync(path.join(vault, rel), 'utf8');
    const sourceMeta = { title: 'Bezug', status: 'aktiv', tags: ['wissen/fakt'], custom: 'manuell gepflegt' };
    const sourceBody = '# Bezug\n\nDiese Erkenntnis betrifft TheHive.\n\nEigener Originaltext.';
    const indexMeta = { title: 'Wissensindex', typ: 'wissen', status: 'aktiv', tags: ['wissen/index'], custom: 'erhalten' };
    const indexBody = '# Wissensindex\n\nManueller Einleitungstext bleibt erhalten.';
    put('20_Wissen/Bezug.md', sourceMeta, sourceBody);
    put('20_Wissen/Wissensindex.md', indexMeta, indexBody);
    put('10_Projekte/TheHive.md', { title: 'TheHive', status: 'aktiv' }, '# TheHive\n\nGepruefter Projektstand.');
    put('30_Entscheidungen/Entscheidungsindex.md', {}, '# Entscheidungsindex\n\nManueller Text bei leerem Metadatenblock.');
    put('00_System/Regeln.md', { typ: 'regeln' }, '# Nur lesende Systemregel\n');
    put('Brain/active.md', { kind: 'brain-active' }, '# Generierte Ansicht bleibt erhalten\n');
    const protectedBefore = ['00_System/Regeln.md', 'Brain/active.md'].map(rel => [rel, read(rel)]);
    const projectBefore = read('10_Projekte/TheHive.md');
    expect(listNoteWrites(vault).writes).toHaveLength(0);

    const first = await syncNavigation({ vault, configPath });
    expect(first.status).toBe('updated');
    expect(first.written.map((row: any) => row.path).sort()).toEqual([
      '10_Projekte/Projektindex.md', '20_Wissen/Bezug.md', '20_Wissen/Vaultindex.md', '20_Wissen/Vaultindex.md', '20_Wissen/Wissensindex.md', '30_Entscheidungen/Entscheidungsindex.md',
    ]);
    const [sourceAfterMeta, sourceAfterBody] = parseFrontmatterText(read('20_Wissen/Bezug.md'));
    const [indexAfterMeta, indexAfterBody] = parseFrontmatterText(read('20_Wissen/Wissensindex.md'));
    expect(sourceAfterMeta).toEqual(sourceMeta);
    expect(indexAfterMeta).toEqual(indexMeta);
    expect(sourceAfterBody.startsWith(sourceBody)).toBe(true);
    expect(indexAfterBody.startsWith(indexBody)).toBe(true);
    expect(sourceAfterBody).toContain('[[10_Projekte/TheHive]]');
    expect(indexAfterBody).toContain('[[20_Wissen/Bezug|Bezug]]');
    expect(read('10_Projekte/Projektindex.md')).toContain('[[10_Projekte/TheHive|TheHive]]');
    expect(parseFrontmatterText(read('10_Projekte/Projektindex.md'))[0].agent).toBe('@codex-desktop-agent');
    expect(read('10_Projekte/TheHive.md')).toBe(projectBefore);
    expect(['00_System/Regeln.md', 'Brain/active.md'].map(rel => [rel, read(rel)])).toEqual(protectedBefore);
    expect(read('20_Wissen/Vaultindex.md')).toContain('[[00_System/Regeln|');
    expect(read('20_Wissen/Vaultindex.md')).toContain('[[Brain/active|');
    const [emptyMeta, emptyBody] = parseFrontmatterText(read('30_Entscheidungen/Entscheidungsindex.md'));
    expect(emptyMeta).toEqual({});
    expect(emptyBody.startsWith('# Entscheidungsindex\n\nManueller Text bei leerem Metadatenblock.')).toBe(true);
    expect(read('30_Entscheidungen/Entscheidungsindex.md').match(/^---$/gm)).toHaveLength(2);
    const audit = listNoteWrites(vault);
    expect(audit.warnings).toEqual([]);
    expect(audit.writes.map((row: any) => [row.target, row.op, row.agent]).sort()).toEqual([
      ['10_Projekte/Projektindex.md', 'create', '@codex-desktop-agent'],
      ['20_Wissen/Bezug.md', 'append', '@codex-desktop-agent'],
      ['20_Wissen/Vaultindex.md', 'append', '@codex-desktop-agent'],
      ['20_Wissen/Vaultindex.md', 'create', '@codex-desktop-agent'],
      ['20_Wissen/Wissensindex.md', 'append', '@codex-desktop-agent'],
      ['30_Entscheidungen/Entscheidungsindex.md', 'append', '@codex-desktop-agent'],
    ]);
    expect(audit.writes.map((row: any) => row.write_id).sort()).toEqual(first.written.map((row: any) => row.write_id).sort());
    expect(process.env.VAULT_AGENT_NAME).toBe('original-navigation-test-agent');
    const writtenBeforeRerun = first.written.map((row: any) => [row.path, read(row.path)]);

    const second = await syncNavigation({ vault, configPath });
    expect(second.status).toBe('unchanged');
    expect(second.written).toEqual([]);
    expect(listNoteWrites(vault).writes).toEqual(audit.writes);
    expect(first.written.map((row: any) => [row.path, read(row.path)])).toEqual(writtenBeforeRerun);
    expect(process.env.VAULT_AGENT_NAME).toBe('original-navigation-test-agent');

    // A deliberate audited revert starts a new logical write, even when
    // original bytes and proposed append equal an earlier successful call.
    const { planNoteRevert, applyNoteRevert } = await load('brain/notes/revert.ts');
    const selector = { agent: '@codex-desktop-agent', path: '20_Wissen/Bezug.md' };
    const rollback = planNoteRevert(vault, selector);
    expect(rollback.entries).toHaveLength(1);
    expect(rollback.entries[0].action).toBe('restore');
    const undone = applyNoteRevert(vault, selector, rollback.digest, { agent: '@codex-desktop-agent', configPath });
    expect(undone.failed).toHaveLength(0);
    expect(parseFrontmatterText(read('20_Wissen/Bezug.md'))[1]).toBe(sourceBody);
    const renewed = await syncNavigation({ vault, configPath });
    expect(renewed.written.map((row: any) => row.path)).toEqual(['20_Wissen/Bezug.md']);
    expect(parseFrontmatterText(read('20_Wissen/Bezug.md'))[1]).toContain('[[10_Projekte/TheHive]]');
  } finally {
    if (previousConfig === undefined) delete process.env.OPEN_SECOND_BRAIN_CONFIG;
    else process.env.OPEN_SECOND_BRAIN_CONFIG = previousConfig;
    if (previousAgent === undefined) delete process.env.VAULT_AGENT_NAME;
    else process.env.VAULT_AGENT_NAME = previousAgent;
    if (path.dirname(temporaryRoot) !== path.resolve(os.tmpdir()) || !path.basename(temporaryRoot).startsWith('thehive-navigation-native-')) throw Error('Unexpected temporary fixture path');
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
