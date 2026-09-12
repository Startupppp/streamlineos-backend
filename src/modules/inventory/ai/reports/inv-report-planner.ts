import { INV_REPORT_FILTERS, type InvReportId, type InvReportSpec } from "./dto/inv-report-spec.schemas";

/**
 * F5 — the report this repository would choose with no model at all.
 *
 * Two jobs, and as with the copilot the second is the load-bearing one.
 *
 * **The fallback.** When the provider is unreachable there is still a question
 * and there are still six reports, so the screen must not go blank. Mapping the
 * question's own words onto a report keeps "outage" and "no answer" from being
 * the same event.
 *
 * **The floor.** The model may only choose among these six; anything else it
 * emits fails the schema and this plan stands. The matching runs against the
 * *question the asker typed* and never against a row, a note or a name that came
 * back from a query — which is why text written into a lot number cannot steer
 * which report runs.
 *
 * The filters this produces are deliberately minimal. A deterministic guess at a
 * date range would be a fabricated constraint presented as the asker's, and a
 * report over the wrong window is more misleading than a report over the default
 * one.
 */

/**
 * Question words to reports, most specific first. Order matters: "expiring
 * stock value" is an expiry question, not a valuation one, because the thing
 * being asked about is the expiry.
 */
const KEYWORD_PLAN: ReadonlyArray<readonly [RegExp, InvReportId]> = [
  [/\b(expir|expiry|expiring|shelf.?life|use.?by|best.?before|out of date)/i, "expiry"],
  [/\b(slow|stale|not sell|dead stock|idle|sitting|gathering dust|obsolet)/i, "slow_moving"],
  [/\b(movement|moved|ledger|transaction|history|audit|posted|receipt|adjustment|transfer)/i, "movements"],
  [/\b(reorder|re-order|replenish|restock|below|running out|need to (buy|order)|shortfall)/i, "reorder"],
  [/\b(valuation|worth|value|cost|capital|tied up|costing|fifo|weighted average)/i, "valuation"],
  [/\b(stock|on hand|on-hand|inventory|quantity|qty|how many|position|available)/i, "stock_summary"],
];

/**
 * What a question with no recognisable word gets.
 *
 * The position, because it is the cheapest report, the least sensitive, and the
 * one that most often turns out to be what somebody meant. A blank answer to a
 * vague question is a worse failure than a slightly wide one.
 */
const DEFAULT_REPORT: InvReportId = "stock_summary";

/**
 * The plan this repository runs with no model. Always a valid spec: the id is a
 * catalog member and the filters are the empty object, which every report's
 * schema accepts because every filter is optional.
 */
export function planReportFromQuestion(question: string): InvReportSpec {
  for (const [pattern, report] of KEYWORD_PLAN) {
    if (pattern.test(question)) return emptySpec(report);
  }
  return emptySpec(DEFAULT_REPORT);
}

/**
 * A spec with no filters, parsed rather than asserted.
 *
 * Going through the schema means the fallback is held to exactly the same
 * validation as the model's output — there is no privileged path that skips it,
 * which is the shape a bypass eventually grows out of.
 */
function emptySpec(report: InvReportId): InvReportSpec {
  const filters = INV_REPORT_FILTERS[report].parse({});
  return { report, filters } as InvReportSpec;
}
