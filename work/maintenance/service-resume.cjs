// Restore only stage outcomes. Process ownership always belongs to the new run.
const KNOWN_STAGES = ['results', 'navigation', 'native', 'learning', 'graph', 'semantic'];
/**
 * Recognize non-null object records while excluding arrays.
 * @param value - Untrusted saved-state field.
 * @returns Whether value is a record.
 */
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/**
 * Accept strings that Date.parse recognizes as finite timestamps.
 * @param value - Untrusted saved timestamp.
 * @returns Whether the timestamp is parseable.
 */
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

/**
 * Restore validated known stage outcomes without reusing process ownership.
 * @param previous - Prior persisted supervisor state, or undefined for a first run.
 * @returns Detached stage records; throws rather than resetting malformed state.
 */
function resumeStages(previous) {
  if (previous === undefined) return {};
  if (!record(previous) || !record(previous.stages)) throw Error('Prior state must contain a stages object');
  const restored = {};
  for (const name of KNOWN_STAGES) {
    if (!Object.hasOwn(previous.stages, name)) continue;
    const stage = previous.stages[name];
    if (!record(stage) || !(stage.exit_code === null || Number.isSafeInteger(stage.exit_code)) || !timestamp(stage.finished_at)) {
      throw Error('Invalid prior stage result: ' + name);
    }
    if (Object.hasOwn(stage, 'retry_not_before') && !timestamp(stage.retry_not_before)) {
      throw Error('Invalid prior retry deadline: ' + name);
    }
    if (Object.hasOwn(stage, 'consecutive_failures') && (!Number.isSafeInteger(stage.consecutive_failures) || stage.consecutive_failures < 0)) {
      throw Error('Invalid prior failure count: ' + name);
    }
    restored[name] = JSON.parse(JSON.stringify(stage));
  }
  return restored;
}

module.exports = { resumeStages };
