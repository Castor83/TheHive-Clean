import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

test('OSB writer keeps its identity through await and restores set or absent identity on success and failure', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-identity-'));
  const previous = process.env.VAULT_AGENT_NAME;
  try {
    const mock = path.join(base, 'write-batch.ts');
    fs.writeFileSync(mock, `export async function applyWriteBatch(_v:any,ops:any[]) {
      await new Promise(r=>setTimeout(r,5));
      if(process.env.VAULT_AGENT_NAME !== 'codex-desktop-agent') throw Error('identity lost during write');
      if(ops[0].fail) throw Error('fixture rejection');
      return 'written';
    }`);
    const source = fs.readFileSync(path.join(import.meta.dir,'project-knowledge-sync.ts'),'utf8');
    const rewritten = source.replace("path.join(os.homedir(), 'projects/open-second-brain/src/core/brain/write-batch.ts')", JSON.stringify(mock));
    assert.notEqual(rewritten, source);
    const target = path.join(base,'sync.ts');
    fs.writeFileSync(target, rewritten + '\nexport {osbWriter};\n');
    const {osbWriter} = await import(pathToFileURL(target).href);
    for (const initial of ['original-agent', undefined]) {
      for (const fail of [false,true]) {
        if(initial === undefined) delete process.env.VAULT_AGENT_NAME;
        else process.env.VAULT_AGENT_NAME = initial;
        if(fail) await assert.rejects(()=>osbWriter(base,{fail},'fixture'), /fixture rejection/);
        else assert.equal(await osbWriter(base,{fail},'fixture'),'written');
        assert.equal(process.env.VAULT_AGENT_NAME,initial);
      }
    }
  } finally {
    if(previous === undefined) delete process.env.VAULT_AGENT_NAME;
    else process.env.VAULT_AGENT_NAME = previous;
    fs.rmSync(base,{recursive:true,force:true});
  }
});
