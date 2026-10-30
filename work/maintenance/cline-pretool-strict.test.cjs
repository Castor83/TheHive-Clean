const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('receipt failures do not replace tool validation', () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'thehive-cline-'));
  const receipt = path.join(profile, '.cline', 'data', 'logs', 'thehive-learning-hooks.jsonl');
  fs.mkdirSync(receipt, { recursive: true }); // A directory forces AppendAllText to fail.
  try {
    const cases = [
      ['ordinary tool', { tool_call: { name: 'read_file', input: {} } }, false],
      ['strict true', { tool_call: { name: 'thehive-memory__brain_create_note', input: { strict: true } } }, false],
      ['missing strict', { tool_call: { name: 'thehive-memory__brain_create_note', input: {} } }, true],
      ['strict false', { tool_call: { name: 'thehive-memory__brain_create_note', input: { strict: false } } }, true],
      ['string strict', { tool_call: { name: 'thehive-memory__brain_create_note', input: { strict: 'true' } } }, true],
      ['wrapped note', { tool_call: { name: 'use_mcp_tool', input: { server_name: 'thehive-memory', tool_name: 'brain_create_note', arguments: {} } } }, true],
      ['extension note', { preToolUse: { toolName: 'thehive-memory____brain__create__note', parameters: { strict: 'true' } } }, false],
      ['invalid input', {}, true],
    ];
    for (const [label, input, cancel] of cases) {
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'cline-pretool-strict.ps1')], {
        input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, USERPROFILE: profile },
      });
      assert.equal(result.status, 0, `${label}: ${result.stderr}`);
      const output = JSON.parse(result.stdout.trim());
      assert.equal(output.cancel, cancel, `${label}: ${result.stdout}`);
      if (cancel && label !== 'invalid input') assert.match(output.errorMessage, /requires explicit strict:true/, label);
      if (label === 'invalid input') assert.match(output.errorMessage, /invalid hook input/);
    }
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
