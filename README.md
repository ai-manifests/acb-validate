# acb-validate

Validate [ACB](https://acb-manifest.dev) budget and settlement entries, audit settlement arithmetic against deliberation records, and re-price deliberations against a posted budget.

## Install

```bash
npm install -g acb-validate
```

## Usage

### Validate ACB entries

```bash
acb-validate ./budget-committed.json
acb-validate ./settlement-recorded.json
acb-validate ./budget.json ./cancel.json ./settlement.json
```

### Validate a complete budget record

Pass a directory containing the ACB entries (`budget_committed`, optionally `budget_cancelled`, `settlement_recorded`) and the related ADJ entries (`deliberation_opened`, `deliberation_closed`, `outcome_observed`) to check cross-entry consistency:

```bash
acb-validate --record ./deliberation/
```

Cross-entry checks:

- `budget_id` matches between `budget_committed` and `settlement_recorded`
- `amount_total` matches between budget and settlement
- `budget_committed.timestamp` ≤ `settlement_recorded.timestamp`
- `deliberation_id` matches across all entries
- `disagreement_magnitude_initial` in settlement is consistent with `deliberation_closed.final_tally`
- Epistemic distributions only target agents declared in `deliberation_opened.participants`
- A budget cannot be both `cancelled` and `settled`

### Re-price a deliberation

Verify the draw computation against a budget and a deliberation result:

```bash
acb-validate --price ./budget.json ./deliberation-closed.json
```

Reports cheap-routine and expensive-routine draws, the unlock signal computed from the tally, and the routine the budget would select. Useful for sanity-checking settlement arithmetic when no settlement entry exists yet.

## Semantic Checks

| Check | Type |
|-------|------|
| `substrate_share + epistemic_share = 1.0` | Error |
| `round_multiplier >= 1` | Error |
| `posted_at <= timestamp` | Error |
| `amount_total > 0` | Error |
| `amount_returned_to_requester = amount_total − draw_total` | Error |
| `sum(distributions) = draw_total` | Error |
| `contribution_breakdown` sums to `amount` per agent | Error |
| `habit_discount_applied` in [0, 1] | Error |
| `expensive_routine_rate >= cheap_routine_rate` | Warning |
| `unlock_threshold` is 0 or 1 (degenerate) | Warning |
| `habit_discount_applied > 0.80` (default-v0 cap) | Warning |
| `unlock_triggered` inconsistent with disagreement magnitude | Warning |
| `mode = deferred` without `outcome_window_seconds` | Warning |
| Settlement targets agent not in deliberation participants | Warning |

## Programmatic Use

```javascript
import {
  validateEntry,
  validateBudgetRecord,
  computeDisagreementMagnitude,
  computeCheapDraw,
  computeExpensiveDraw,
  selectRoutine,
} from 'acb-validate';

const result = validateEntry(budgetEntry);
const recordResult = validateBudgetRecord(allEntries);

const magnitude = computeDisagreementMagnitude({
  approve_weight: 0.71,
  reject_weight: 0.64,
  abstain_weight: 0.18,
});

const draw = computeExpensiveDraw(
  { expensive_routine_rate: 200, round_multiplier: 1.5 },
  3,    // participants
  1,    // rounds
  0.80  // habit discount
);

const routine = selectRoutine(budget, initialTally, roundCount, termination);
```

## How It Composes

`acb-validate` extends the same envelope `adj-validate` validates against. ACB entries (`budget_committed`, `budget_cancelled`, `settlement_recorded`) live in the same journal as ADJ entries (`deliberation_opened`, `proposal_emitted`, `round_event`, `deliberation_closed`, `outcome_observed`) and inherit the same hash chaining, append-only guarantees, and replay verification.

Run both validators against a journal directory for full coverage:

```bash
adj-validate --deliberation ./journal/
acb-validate --record ./journal/
```

## Status

**v0.1** — Validates against ACB spec v0 (draft, pre-implementation).

## License

Apache-2.0 — see [`LICENSE`](LICENSE) for the full license text and [`NOTICE`](NOTICE) for attribution.
