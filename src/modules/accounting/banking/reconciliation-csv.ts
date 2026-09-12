import { csvMoney, toCsv, withCsvPreamble, type CsvCell } from "../reports/report-csv";
import type { ReconciliationProof } from "./reconciliation.service";

/**
 * The reconciliation report as CSV (PRD 04 S3).
 *
 * It is laid out as the proof itself rather than as a table dump: the two
 * adjusted figures and the gap between them come first, then the items that
 * explain the gap. An accountant reading this should be able to answer "why
 * does the bank disagree with the books" without opening the app.
 */
export function reconciliationCsv(proof: ReconciliationProof): string {
  const rows: (readonly CsvCell[])[] = [];

  rows.push(["The proof", "", ""]);
  rows.push(["Books say (GL balance)", csvMoney(proof.glBalanceMinor, proof.currency), ""]);
  rows.push([
    "less movements not on the statement",
    csvMoney(proof.unmatchedGlMinor, proof.currency),
    "",
  ]);
  rows.push(["= adjusted books", csvMoney(proof.adjustedGlMinor, proof.currency), ""]);
  rows.push(["", "", ""]);
  rows.push(["Bank says (closing balance)", csvMoney(proof.statementClosingMinor, proof.currency), ""]);
  rows.push([
    "less movements not in the books",
    csvMoney(proof.unmatchedStatementMinor, proof.currency),
    "",
  ]);
  rows.push(["= adjusted bank", csvMoney(proof.adjustedStatementMinor, proof.currency), ""]);
  rows.push(["", "", ""]);
  rows.push([
    "Left unexplained",
    csvMoney(proof.differenceMinor, proof.currency),
    proof.holds ? "Reconciled" : "Does not reconcile — investigate below",
  ]);

  if (proof.openingVarianceMinor !== 0) {
    rows.push([
      "Carried in from before this period",
      csvMoney(proof.openingVarianceMinor, proof.currency),
      "Books at period start, less the bank's stated opening",
    ]);
  }

  if (proof.unmatchedStatementLines.length > 0) {
    rows.push(["", "", ""]);
    rows.push(["On the statement, not in the books", "", ""]);
    rows.push(["Date", "Amount", "Description"]);
    for (const line of proof.unmatchedStatementLines) {
      rows.push([
        line.valueDate,
        csvMoney(line.amountMinor, proof.currency),
        line.description ?? line.bankReference ?? "",
      ]);
    }
  }

  if (proof.unmatchedGlLines.length > 0) {
    rows.push(["", "", ""]);
    rows.push(["In the books, not on the statement", "", ""]);
    rows.push(["Date", "Amount", "Entry"]);
    for (const line of proof.unmatchedGlLines) {
      rows.push([
        line.journalDate,
        csvMoney(line.amountMinor, proof.currency),
        `${line.journalNumber}${line.description ? ` — ${line.description}` : ""}`,
      ]);
    }
  }

  return withCsvPreamble(
    [
      ["Report", "Bank reconciliation"],
      ["Period", `${proof.periodStart} to ${proof.periodEnd}`],
      // Reconciliation compares in the bank's own currency, never functional.
      ["Currency", proof.currency],
      ["Reconciled", proof.holds ? "Yes" : "No"],
    ],
    toCsv(["", "Amount", "Detail"], rows),
  );
}
