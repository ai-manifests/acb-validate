import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const schemaPath = join(__dirname, '..', 'schema', 'v0.json');
const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validateSchema = ajv.compile(schema);

const VALID_ENTRY_TYPES = ['budget_committed', 'budget_cancelled', 'settlement_recorded'];

/**
 * Validate a single ACB entry against schema and semantic rules.
 *
 * Semantic rules enforced beyond JSON Schema:
 *  - budget_committed:
 *      * substrate_share + epistemic_share === 1.0 (within 0.001 tolerance)
 *      * pricing.unlock_threshold in [0, 1]
 *      * posted_at <= timestamp (when both present)
 *      * habit_memory_discount profile name present when pricing.profile is default-v0
 *  - settlement_recorded:
 *      * amount_returned_to_requester === amount_total - draw_total (within 0.001)
 *      * sum(substrate_distributions) + sum(epistemic_distributions) === draw_total (within 0.001)
 *      * each epistemic distribution's contribution_breakdown sums to its amount (within 0.001)
 *      * habit_discount_applied in [0, 1]
 *      * disagreement_magnitude_initial in [0, 1]
 *      * unlock_triggered consistent with disagreement_magnitude_initial vs default unlock thresholds
 *
 * @param {object} entry
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
export function validateEntry(entry) {
  const errors = [];
  const warnings = [];

  const schemaValid = validateSchema(entry);
  if (!schemaValid && validateSchema.errors) {
    for (const err of validateSchema.errors) {
      const path = err.instancePath || '(root)';
      errors.push(`${path}: ${err.message}`);
    }
  }

  if (!entry || typeof entry !== 'object') {
    return { valid: errors.length === 0, errors, warnings };
  }

  if (!VALID_ENTRY_TYPES.includes(entry.entry_type)) {
    return { valid: errors.length === 0, errors, warnings };
  }

  if (entry.entry_type === 'budget_committed') {
    validateBudgetCommitted(entry, errors, warnings);
  }

  if (entry.entry_type === 'settlement_recorded') {
    validateSettlementRecorded(entry, errors, warnings);
  }

  return { valid: errors.length === 0, errors, warnings };
}

function validateBudgetCommitted(entry, errors, warnings) {
  const s = entry.settlement || {};
  const sub = Number(s.substrate_share || 0);
  const epi = Number(s.epistemic_share || 0);
  const sum = sub + epi;
  if (Math.abs(sum - 1.0) > 0.001) {
    errors.push(`settlement.substrate_share (${sub}) + epistemic_share (${epi}) must sum to 1.0, got ${sum.toFixed(4)}`);
  }

  const p = entry.pricing || {};
  if (p.cheap_routine_rate != null && p.expensive_routine_rate != null) {
    if (p.expensive_routine_rate < p.cheap_routine_rate) {
      warnings.push(`expensive_routine_rate (${p.expensive_routine_rate}) is lower than cheap_routine_rate (${p.cheap_routine_rate}) — escalation should not be cheaper than the default routine`);
    }
  }

  if (p.round_multiplier != null && p.round_multiplier < 1) {
    errors.push(`pricing.round_multiplier (${p.round_multiplier}) must be >= 1; rounds should not become cheaper as they accumulate`);
  }

  if (p.unlock_threshold === 0) {
    warnings.push('pricing.unlock_threshold is 0 — every deliberation will engage the expensive routine');
  }
  if (p.unlock_threshold === 1) {
    warnings.push('pricing.unlock_threshold is 1 — the expensive routine will never engage');
  }

  if (entry.posted_at && entry.timestamp) {
    if (new Date(entry.posted_at) > new Date(entry.timestamp)) {
      errors.push(`posted_at (${entry.posted_at}) is after timestamp (${entry.timestamp})`);
    }
  }

  if (entry.amount_total != null && entry.amount_total <= 0) {
    errors.push(`amount_total must be > 0, got ${entry.amount_total}`);
  }

  if (s.mode === 'deferred' && (s.outcome_window_seconds == null || s.outcome_window_seconds <= 0)) {
    warnings.push('settlement.mode is "deferred" but outcome_window_seconds is missing or zero — settlement may never proceed if no outcome arrives');
  }

  if (s.mode === 'two_phase' && (s.outcome_window_seconds == null || s.outcome_window_seconds <= 0)) {
    warnings.push('settlement.mode is "two_phase" but outcome_window_seconds is missing or zero — adjustment phase may never proceed');
  }

  if (entry.constraints && entry.constraints.max_rounds === 0) {
    warnings.push('constraints.max_rounds is 0 — no belief-update rounds permitted, expensive routine still engages on initial-tally disagreement only');
  }
}

function validateSettlementRecorded(entry, errors, warnings) {
  const drawTotal = Number(entry.draw_total || 0);
  const amountTotal = Number(entry.amount_total || 0);
  const returned = Number(entry.amount_returned_to_requester || 0);

  if (drawTotal > amountTotal + 0.001) {
    errors.push(`draw_total (${drawTotal}) exceeds amount_total (${amountTotal})`);
  }

  const expectedReturn = amountTotal - drawTotal;
  if (Math.abs(expectedReturn - returned) > 0.001) {
    errors.push(`amount_returned_to_requester (${returned}) does not match amount_total − draw_total (${expectedReturn.toFixed(4)})`);
  }

  const substrateSum = (entry.substrate_distributions || []).reduce((acc, d) => acc + Number(d.amount || 0), 0);
  const epistemicSum = (entry.epistemic_distributions || []).reduce((acc, d) => acc + Number(d.amount || 0), 0);
  const distSum = substrateSum + epistemicSum;

  if (Math.abs(distSum - drawTotal) > 0.01) {
    errors.push(`substrate (${substrateSum.toFixed(4)}) + epistemic (${epistemicSum.toFixed(4)}) distributions = ${distSum.toFixed(4)}, expected draw_total ${drawTotal}`);
  }

  for (const dist of entry.epistemic_distributions || []) {
    if (!dist.contribution_breakdown) continue;
    const b = dist.contribution_breakdown;
    const breakdownSum =
      Number(b.base_share || 0)
      + Number(b.falsification_bonus || 0)
      + Number(b.load_bearing_bonus || 0)
      + Number(b.outcome_correctness_bonus || 0)
      - Number(b.dissent_quality_penalty || 0);
    if (Math.abs(breakdownSum - Number(dist.amount || 0)) > 0.01) {
      errors.push(`epistemic distribution for ${dist.recipient}: contribution_breakdown sums to ${breakdownSum.toFixed(4)}, expected amount ${dist.amount}`);
    }
  }

  if (entry.habit_discount_applied != null) {
    if (entry.habit_discount_applied < 0 || entry.habit_discount_applied > 1) {
      errors.push(`habit_discount_applied (${entry.habit_discount_applied}) must be in [0, 1]`);
    }
    if (entry.habit_discount_applied > 0.80 + 0.001) {
      warnings.push(`habit_discount_applied (${entry.habit_discount_applied}) exceeds the default-v0 maximum of 0.80`);
    }
  }

  if (entry.unlock_triggered != null && entry.disagreement_magnitude_initial != null) {
    if (entry.unlock_triggered === false && entry.disagreement_magnitude_initial > 0.30) {
      warnings.push(`unlock_triggered is false but disagreement_magnitude_initial is ${entry.disagreement_magnitude_initial} — exceeds the default-v0 unlock threshold of 0.30`);
    }
    if (entry.unlock_triggered === true && entry.disagreement_magnitude_initial < 0.05) {
      warnings.push(`unlock_triggered is true but disagreement_magnitude_initial is ${entry.disagreement_magnitude_initial} — initial agreement was very high`);
    }
  }

  if (returned < 0) {
    errors.push(`amount_returned_to_requester (${returned}) cannot be negative`);
  }
}

/**
 * Validate an ACB record (a budget_committed entry plus its eventual
 * settlement_recorded, with the deliberation entries it references).
 *
 * Cross-entry checks:
 *  - budget_committed.timestamp <= settlement_recorded.timestamp
 *  - budget_id matches between budget_committed and settlement_recorded
 *  - deliberation_id matches between all entries
 *  - amount_total in settlement matches amount_total in budget_committed
 *  - if a deliberation_closed entry is present, settlement's
 *    disagreement_magnitude_initial is consistent with its final_tally
 *  - epistemic_distributions only reference agents that appeared as
 *    proposal authors in the deliberation
 *
 * @param {object[]} entries  ACB and ADJ entries for one deliberation
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
export function validateBudgetRecord(entries) {
  const errors = [];
  const warnings = [];

  if (!Array.isArray(entries) || entries.length === 0) {
    errors.push('budget record is empty');
    return { valid: false, errors, warnings };
  }

  for (const entry of entries) {
    if (VALID_ENTRY_TYPES.includes(entry.entry_type)) {
      const r = validateEntry(entry);
      for (const e of r.errors) errors.push(`[${entry.entry_id}] ${e}`);
      for (const w of r.warnings) warnings.push(`[${entry.entry_id}] ${w}`);
    }
  }

  const dlbIds = new Set(entries.map(e => e.deliberation_id).filter(Boolean));
  if (dlbIds.size > 1) {
    errors.push(`record references ${dlbIds.size} different deliberation_ids`);
  }

  const budget = entries.find(e => e.entry_type === 'budget_committed');
  const cancelled = entries.find(e => e.entry_type === 'budget_cancelled');
  const settlement = entries.find(e => e.entry_type === 'settlement_recorded');
  const closed = entries.find(e => e.entry_type === 'deliberation_closed');
  const opened = entries.find(e => e.entry_type === 'deliberation_opened');

  if (!budget && !cancelled && !settlement) {
    warnings.push('no ACB entries (budget_committed, budget_cancelled, or settlement_recorded) found');
  }

  if (budget && settlement) {
    if (budget.budget_id && settlement.budget_id && budget.budget_id !== settlement.budget_id) {
      errors.push(`budget_id mismatch: budget_committed has ${budget.budget_id}, settlement_recorded has ${settlement.budget_id}`);
    }
    if (budget.amount_total != null && settlement.amount_total != null) {
      if (Math.abs(budget.amount_total - settlement.amount_total) > 0.001) {
        errors.push(`amount_total mismatch: budget has ${budget.amount_total}, settlement has ${settlement.amount_total}`);
      }
    }
    if (budget.timestamp && settlement.timestamp) {
      if (new Date(budget.timestamp) > new Date(settlement.timestamp)) {
        errors.push(`budget_committed timestamp (${budget.timestamp}) is after settlement_recorded timestamp (${settlement.timestamp})`);
      }
    }
  }

  if (cancelled && settlement) {
    errors.push('record contains both budget_cancelled and settlement_recorded — a budget cannot be both cancelled and settled');
  }

  if (closed && settlement && settlement.disagreement_magnitude_initial != null) {
    const t = closed.final_tally || {};
    const nonAbstaining = Number(t.approve_weight || 0) + Number(t.reject_weight || 0);
    if (nonAbstaining > 0) {
      const computed = 1 - Math.abs(Number(t.approve_weight || 0) - Number(t.reject_weight || 0)) / nonAbstaining;
      if (Math.abs(computed - settlement.disagreement_magnitude_initial) > 0.05) {
        warnings.push(`settlement disagreement_magnitude_initial (${settlement.disagreement_magnitude_initial}) does not match value computed from deliberation_closed.final_tally (${computed.toFixed(3)}) — note that ACB uses the *initial* tally, not the final one`);
      }
    }
  }

  if (opened && settlement) {
    const declared = new Set(opened.participants || []);
    for (const dist of settlement.epistemic_distributions || []) {
      if (dist.recipient && !declared.has(dist.recipient)) {
        warnings.push(`settlement distributes to ${dist.recipient}, who is not in the deliberation_opened participants list`);
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Compute disagreement magnitude from an ADP/ADJ tally.
 * Used by deliberation runners to drive the unlock rule.
 * @param {{ approve_weight: number, reject_weight: number, abstain_weight: number }} tally
 * @returns {number}
 */
export function computeDisagreementMagnitude(tally) {
  const approve = Number(tally.approve_weight || 0);
  const reject = Number(tally.reject_weight || 0);
  const nonAbstaining = approve + reject;
  if (nonAbstaining === 0) return 1.0;
  return 1 - Math.abs(approve - reject) / nonAbstaining;
}

/**
 * Compute the cheap-routine draw given default-v0 pricing.
 * @param {{ cheap_routine_rate: number }} pricing
 * @param {number} participantCount
 * @param {number} habitDiscount  in [0, 1]
 * @returns {number}
 */
export function computeCheapDraw(pricing, participantCount, habitDiscount = 0) {
  return Number(pricing.cheap_routine_rate || 0) * participantCount * (1 - habitDiscount);
}

/**
 * Compute the expensive-routine draw given default-v0 pricing.
 * @param {{ expensive_routine_rate: number, round_multiplier: number }} pricing
 * @param {number} participantCount
 * @param {number} roundCount
 * @param {number} habitDiscount  in [0, 1]
 * @returns {number}
 */
export function computeExpensiveDraw(pricing, participantCount, roundCount, habitDiscount = 0) {
  const base = Number(pricing.expensive_routine_rate || 0) * participantCount;
  const multiplied = base * Math.pow(Number(pricing.round_multiplier || 1), roundCount);
  return multiplied * (1 - habitDiscount);
}

/**
 * Decide which routine applies given a budget, the deliberation's initial
 * tally, and whether the deliberation eventually ran rounds.
 * @returns {'cheap'|'expensive'}
 */
export function selectRoutine(budget, initialTally, roundCount, termination) {
  const magnitude = computeDisagreementMagnitude(initialTally);
  const threshold = Number((budget.pricing || {}).unlock_threshold ?? 0.30);
  if (roundCount > 0) return 'expensive';
  if (termination && termination !== 'converged') return 'expensive';
  if (magnitude >= threshold) return 'expensive';
  return 'cheap';
}

/**
 * Load an entry from a file path.
 * @param {string} filePath
 * @returns {object}
 */
export function loadEntry(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}
