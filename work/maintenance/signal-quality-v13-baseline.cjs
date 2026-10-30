'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const root = 'C:\\TheHive';
const home = 'C:\\Users\\USER';
const source = path.join(home, 'projects', 'open-second-brain');
const bun = path.join(home, '.bun', 'bin', 'bun.exe');
const cli = path.join(source, 'src', 'cli', 'main.ts');

const reviewFile = path.join(
  home, 'Desktop',
  'thehive-signals-review-20261024-v13.json'
);

const expected = {
  'never-ask-for-upload': 'source_review',
  'use-chat-memory': 'source_review',
  'proactive-web-search': 'source_review',
  'answer-style': 'source_review',
  'make-decision': 'source_review',
  'always-tell-me-why': 'candidate',
  'stop-spinning-in-circles': 'reject',
  'avoid-stopping-repairing': 'reject',
  'avoid-testing-yourself': 'reject'
};

/**
 * Classify a proposal against the narrow historical reference heuristics.
 * @param item - Proposal containing the principle text.
 * @param original - Original source-turn text, if available.
 * @returns Advisory decision/reason; no model call or memory acceptance.
 */
function assess(item, original) {
  if (typeof original !== 'string' || !original.trim()) {
    return {
      decision: 'reject',
      reason: 'Originalbeleg fehlt'
    };
  }

  if (
    /^\s*# AGENTS\.md instructions/i.test(original) ||
    /<INSTRUCTIONS>/i.test(original.slice(0, 1000))
  ) {
    return {
      decision: 'source_review',
      reason: 'Eingebetteter Anweisungsblock; Nutzerpräferenz nicht unabhängig belegt'
    };
  }

  if (
    /always tell me what you are doing and why/i.test(item.principle) &&
    /immer\s+sagst/i.test(original) &&
    /was du machst/i.test(original) &&
    /warum/i.test(original)
  ) {
    return {
      decision: 'candidate',
      reason: 'Expliziter dauerhafter Wunsch; weitere Freigabe erforderlich'
    };
  }

  if (
    /do not (spin in circles|stop repairing|test yourself)/i.test(item.principle) &&
    /(du sollst|jetzt|im kreis|schon wieder)/i.test(original)
  ) {
    return {
      decision: 'reject',
      reason: 'Situationsbezogene Aufforderung oder Kritik'
    };
  }

  return {
    decision: 'needs_review',
    reason: 'Keine ausreichend sichere automatische Einordnung'
  };
}

const review = JSON.parse(fs.readFileSync(reviewFile, 'utf8'));

if (
  review.format_version !== 1 ||
  review.vault !== root ||
  !Array.isArray(review.items)
) {
  throw Error('Unerwartetes Review-Format');
}

const run = spawnSync(bun, [
  'run', cli, 'brain', 'extract-signals',
  review.session_ref,
  '--vault', root,
  '--agent', 'thehive-ollama-signal-review',
  '--json'
], {
  cwd: source,
  encoding: 'utf8',
  timeout: 120000,
  maxBuffer: 8 * 1024 * 1024
});

if (run.error || run.status !== 0) {
  throw Error('Originalbelege konnten nicht geladen werden: ' +
    (run.error?.message || run.stderr || run.status));
}

const plan = JSON.parse(run.stdout);

if (
  plan.surveyed_turns_hash !== review.surveyed_turns_hash ||
  !Array.isArray(plan.turns_mined)
) {
  throw Error('Quellstand passt nicht zum Prüfbericht');
}

const sources = new Map(
  plan.turns_mined.map(t => [t.turn_id, t.text])
);

const results = review.items.map(item => {
  const original = sources.get(item.source_turn);
  const result = assess(item, original);
  return {
    topic: item.topic,
    source_turn: item.source_turn,
    source_sha256: original
      ? crypto.createHash('sha256').update(original).digest('hex')
      : null,
    ...result,
    expected: expected[item.topic] ?? 'unknown',
    matches_reference: result.decision === expected[item.topic]
  };
});

const counts = {
  candidate: results.filter(r => r.decision === 'candidate').length,
  source_review: results.filter(r => r.decision === 'source_review').length,
  reject: results.filter(r => r.decision === 'reject').length,
  needs_review: results.filter(r => r.decision === 'needs_review').length
};

const passed =
  results.length === 9 &&
  results.every(r => r.matches_reference);

const output = {
  version: 'v1.3-reference-baseline',
  passed,
  automatic_commit_allowed: false,
  session_ref: review.session_ref,
  counts,
  results
};

const dir = path.join(root, 'work', 'verification');
fs.mkdirSync(dir, { recursive: true });

const filename = path.join(
  dir,
  'signal-quality-v13-' +
  new Date().toISOString().replace(/[:.]/g, '-') +
  '.json'
);

fs.writeFileSync(filename, JSON.stringify(output, null, 2), {
  flag: 'wx'
});

console.log(JSON.stringify({
  passed,
  counts,
  report: filename
}, null, 2));

if (!passed) process.exitCode = 1;
