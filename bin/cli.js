#!/usr/bin/env node

import { readdirSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import {
  validateEntry,
  validateBudgetRecord,
  computeDisagreementMagnitude,
  computeCheapDraw,
  computeExpensiveDraw,
  selectRoutine,
  loadEntry,
} from '../src/index.js';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';

function pass(msg) { console.log(`  ${GREEN}\u2713${RESET} ${msg}`); }
function fail(msg) { console.log(`  ${RED}\u2717${RESET} ${msg}`); }
function warn(msg) { console.log(`  ${YELLOW}\u26A0${RESET} ${msg}`); }
function info(msg) { console.log(`  ${CYAN}\u2139${RESET} ${msg}`); }
function heading(msg) { console.log(`\n${BOLD}${msg}${RESET}`); }

const args = process.argv.slice(2);

if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  console.log(`
${BOLD}acb-validate${RESET} — Validate ACB budget and settlement entries and audit settlement arithmetic

${BOLD}Usage:${RESET}
  acb-validate <file> [file...]              Validate one or more ACB entries
  acb-validate --record <dir>                Validate a complete budget record (ACB + ADJ entries)
  acb-validate --price <budget.json> <closed.json>
                                              Re-price a deliberation against a budget

${BOLD}Examples:${RESET}
  acb-validate ./budget-committed.json
  acb-validate ./settlement-recorded.json
  acb-validate --record ./deliberation/
  acb-validate --price ./budget.json ./deliberation-closed.json

${BOLD}Options:${RESET}
  --record <dir>          Validate all .json entries in dir as one budget record
  --price <budget> <closed>
                          Re-compute the draw against a deliberation_closed entry
  --json                  Output results as JSON
  --help                  Show this help
`);
  process.exit(0);
}

const recordMode = args.includes('--record');
const priceMode = args.includes('--price');
const inputs = args.filter(a => !a.startsWith('--'));

let totalErrors = 0;
let totalWarnings = 0;

async function run() {
  if (priceMode) {
    await runPricing();
  } else if (recordMode) {
    await runRecordValidation();
  } else {
    await runEntryValidation();
  }
}

async function runEntryValidation() {
  heading('ACB Entry Validator');

  for (const input of inputs) {
    console.log(`${DIM}File: ${input}${RESET}`);

    let entry;
    try {
      entry = loadEntry(resolve(input));
    } catch (e) {
      fail(`Failed to load: ${e.message}`);
      totalErrors++;
      continue;
    }

    heading('Schema Validation');
    const result = validateEntry(entry);

    if (result.errors.length === 0) {
      pass('Valid against ACB entry schema v0');
    } else {
      for (const err of result.errors) { fail(err); totalErrors++; }
    }

    heading('Entry Info');
    info(`Type: ${BOLD}${entry.entry_type}${RESET}`);
    info(`Deliberation: ${entry.deliberation_id}`);
    if (entry.entry_id) info(`Entry ID: ${entry.entry_id}`);

    if (entry.entry_type === 'budget_committed') {
      info(`Budget ID: ${entry.budget_id}`);
      info(`Authority: ${entry.budget_authority}`);
      info(`Amount: ${BOLD}${entry.amount_total} ${entry.denomination?.unit || 'EU'}${RESET}` +
        (entry.denomination?.external_unit
          ? ` ${DIM}(\u2248 ${(entry.amount_total * (entry.denomination.external_rate || 0)).toFixed(2)} ${entry.denomination.external_unit})${RESET}`
          : ''));
      info(`Pricing profile: ${entry.pricing?.profile}`);
      info(`Cheap rate: ${entry.pricing?.cheap_routine_rate} EU/agent  |  Expensive rate: ${entry.pricing?.expensive_routine_rate} EU/agent  |  Round x${entry.pricing?.round_multiplier}`);
      info(`Unlock threshold: ${entry.pricing?.unlock_threshold}`);
      info(`Settlement mode: ${entry.settlement?.mode}`);
      info(`Substrate ${(entry.settlement?.substrate_share * 100).toFixed(0)}% / Epistemic ${(entry.settlement?.epistemic_share * 100).toFixed(0)}%`);
    }

    if (entry.entry_type === 'budget_cancelled') {
      info(`Budget ID: ${entry.budget_id}`);
      info(`Reason: ${entry.reason}`);
    }

    if (entry.entry_type === 'settlement_recorded') {
      info(`Budget ID: ${entry.budget_id}`);
      info(`Profile: ${entry.settlement_profile}`);
      info(`Routine: ${BOLD}${entry.unlock_triggered ? `${YELLOW}expensive${RESET}` : `${GREEN}cheap${RESET}`}${RESET}`);
      info(`Disagreement magnitude: ${entry.disagreement_magnitude_initial}`);
      info(`Habit discount applied: ${(entry.habit_discount_applied * 100).toFixed(1)}%`);
      info(`Draw: ${BOLD}${entry.draw_total}${RESET} of ${entry.amount_total} EU  (returned ${entry.amount_returned_to_requester} EU)`);
      info(`Substrate distributions: ${(entry.substrate_distributions || []).length}`);
      info(`Epistemic distributions: ${(entry.epistemic_distributions || []).length}`);
    }

    if (result.warnings.length > 0) {
      heading('Warnings');
      for (const w of result.warnings) { warn(w); totalWarnings++; }
    }

    if (inputs.length > 1) console.log(`\n${'─'.repeat(60)}`);
  }

  printResult();
}

async function runRecordValidation() {
  heading('ACB Budget Record Validator');

  const dir = inputs[0];
  if (!dir || !existsSync(dir)) {
    fail(`Directory not found: ${dir}`);
    process.exit(1);
  }

  const files = readdirSync(dir).filter(f => f.endsWith('.json')).sort();
  console.log(`${DIM}Directory: ${dir} (${files.length} entries)${RESET}`);

  const entries = [];
  for (const file of files) {
    try {
      const obj = loadEntry(resolve(join(dir, file)));
      if (obj.entry_id) entries.push(obj);
    } catch (e) {
      fail(`Failed to load ${file}: ${e.message}`);
      totalErrors++;
    }
  }

  entries.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  const result = validateBudgetRecord(entries);

  heading('Entry Summary');
  const typeCounts = {};
  for (const e of entries) {
    typeCounts[e.entry_type] = (typeCounts[e.entry_type] || 0) + 1;
  }
  for (const [type, count] of Object.entries(typeCounts)) {
    info(`${type}: ${count}`);
  }

  heading('Budget Record Consistency');
  if (result.errors.length === 0) {
    pass('All cross-entry consistency checks passed');
  }
  for (const err of result.errors) { fail(err); totalErrors++; }

  if (result.warnings.length > 0) {
    heading('Warnings');
    for (const w of result.warnings) { warn(w); totalWarnings++; }
  }

  const budget = entries.find(e => e.entry_type === 'budget_committed');
  const settlement = entries.find(e => e.entry_type === 'settlement_recorded');

  if (budget) {
    heading('Budget Summary');
    info(`Budget: ${budget.budget_id}`);
    info(`Authority: ${budget.budget_authority}`);
    info(`Amount: ${budget.amount_total} ${budget.denomination?.unit || 'EU'}`);
  }

  if (settlement) {
    heading('Settlement Summary');
    info(`Routine: ${BOLD}${settlement.unlock_triggered ? `${YELLOW}expensive${RESET}` : `${GREEN}cheap${RESET}`}${RESET}`);
    info(`Drew ${settlement.draw_total} EU (${((settlement.draw_total / (settlement.amount_total || 1)) * 100).toFixed(1)}% of budget)`);
    info(`Habit discount: ${(settlement.habit_discount_applied * 100).toFixed(1)}%`);
    info(`Returned ${settlement.amount_returned_to_requester} EU to requester`);
  }

  printResult();
}

async function runPricing() {
  heading('ACB Re-pricing');

  const budgetPath = inputs[0];
  const closedPath = inputs[1];
  if (!budgetPath || !closedPath) {
    fail('--price requires <budget.json> <deliberation_closed.json>');
    process.exit(1);
  }

  const budget = loadEntry(resolve(budgetPath));
  const closed = loadEntry(resolve(closedPath));

  if (budget.entry_type !== 'budget_committed') {
    fail(`First argument must be a budget_committed entry, got ${budget.entry_type}`);
    process.exit(1);
  }
  if (closed.entry_type !== 'deliberation_closed') {
    fail(`Second argument must be a deliberation_closed entry, got ${closed.entry_type}`);
    process.exit(1);
  }

  const tally = closed.final_tally || {};
  const magnitude = computeDisagreementMagnitude(tally);
  const participantCount = Object.keys(closed.weights || {}).length;
  const roundCount = Number(closed.round_count || 0);
  const routine = selectRoutine(budget, tally, roundCount, closed.termination);

  heading('Pricing Inputs');
  info(`Participants: ${participantCount}`);
  info(`Rounds: ${roundCount}`);
  info(`Termination: ${closed.termination}`);
  info(`Disagreement magnitude (from final tally): ${magnitude.toFixed(4)}`);
  info(`Unlock threshold: ${budget.pricing?.unlock_threshold}`);
  info(`Selected routine: ${BOLD}${routine === 'expensive' ? `${YELLOW}expensive${RESET}` : `${GREEN}cheap${RESET}`}${RESET}`);

  heading('Computed Draws (no habit discount)');
  const cheap = computeCheapDraw(budget.pricing, participantCount, 0);
  const expensive = computeExpensiveDraw(budget.pricing, participantCount, roundCount, 0);
  info(`Cheap routine: ${cheap.toFixed(2)} EU`);
  info(`Expensive routine: ${expensive.toFixed(2)} EU`);
  info(`Selected: ${BOLD}${(routine === 'cheap' ? cheap : expensive).toFixed(2)} EU${RESET}`);

  heading('With Habit Discount');
  for (const discount of [0.20, 0.50, 0.80]) {
    const c = computeCheapDraw(budget.pricing, participantCount, discount);
    const e = computeExpensiveDraw(budget.pricing, participantCount, roundCount, discount);
    info(`@ ${(discount * 100).toFixed(0)}% discount: cheap=${c.toFixed(2)}, expensive=${e.toFixed(2)} EU`);
  }

  warn('Note: this re-pricing uses the deliberation_closed final_tally as a proxy for the initial tally. ACB strictly uses the *initial* tally for the unlock signal — these may differ if belief-update rounds shifted the tally.');

  printResult();
}

function printResult() {
  console.log('');
  if (totalErrors === 0 && totalWarnings === 0) {
    console.log(`${GREEN}${BOLD}\u2713 All checks passed${RESET}`);
    process.exit(0);
  } else if (totalErrors === 0) {
    console.log(`${GREEN}${BOLD}\u2713 All checks passed${RESET} ${YELLOW}(${totalWarnings} warning${totalWarnings > 1 ? 's' : ''})${RESET}`);
    process.exit(0);
  } else {
    console.log(`${RED}${BOLD}\u2717 ${totalErrors} error(s) found${RESET}`);
    process.exit(1);
  }
}

run().catch(err => {
  console.error(`${RED}Fatal: ${err.message}${RESET}`);
  process.exit(2);
});
