import type { GlAccountType } from "../../../db/schema";
import { classOf, classSigned, negated, type AccountMovement } from "./report-queries";
import { label, type LabelMode } from "./report-labels";

export interface ProfitLossLine {
  accountId: string;
  code: string;
  name: string;
  accountType: GlAccountType;
  amountMinor: number;
  /** Null unless a comparative was asked for. */
  priorAmountMinor: number | null;
  varianceMinor: number | null;
}

export interface ProfitLossSection {
  key: "income" | "expense";
  label: string;
  lines: ProfitLossLine[];
  totalMinor: number;
  priorTotalMinor: number | null;
}

export function buildProfitLossSection(
  key: "income" | "expense",
  labelKey: "section.income" | "section.expense",
  movements: readonly AccountMovement[],
  prior: ReadonlyMap<string, AccountMovement>,
  withComparative: boolean,
  mode: LabelMode,
): ProfitLossSection {
  const wanted = key === "income" ? "INCOME" : "EXPENSE";
  const lines: ProfitLossLine[] = [];
  let totalMinor = 0;
  let priorTotalMinor = 0;

  for (const m of movements) {
    if (classOf(m.accountType) !== wanted) continue;

    const amountMinor = classSigned(m.accountType, m.debitMinor, m.creditMinor);
    const priorRow = prior.get(m.accountId);
    const priorAmountMinor = withComparative
      ? priorRow
        ? classSigned(priorRow.accountType, priorRow.debitMinor, priorRow.creditMinor)
        : 0
      : null;

    totalMinor += amountMinor;
    if (priorAmountMinor !== null) priorTotalMinor += priorAmountMinor;

    lines.push({
      accountId: m.accountId,
      code: m.code,
      name: m.name,
      accountType: m.accountType,
      amountMinor,
      priorAmountMinor,
      varianceMinor: priorAmountMinor === null ? null : amountMinor - priorAmountMinor,
    });
  }

  // An account that moved only in the comparative period still belongs on
  // the report — otherwise "we stopped spending on X" is invisible.
  if (withComparative) {
    const seen = new Set(lines.map((l) => l.accountId));
    for (const [accountId, m] of prior) {
      if (seen.has(accountId) || classOf(m.accountType) !== wanted) continue;
      const priorAmountMinor = classSigned(m.accountType, m.debitMinor, m.creditMinor);
      priorTotalMinor += priorAmountMinor;
      lines.push({
        accountId,
        code: m.code,
        name: m.name,
        accountType: m.accountType,
        amountMinor: 0,
        priorAmountMinor,
        varianceMinor: negated(priorAmountMinor),
      });
    }
  }

  lines.sort((a, b) => a.code.localeCompare(b.code));

  return {
    key,
    label: label(labelKey, mode),
    lines,
    totalMinor,
    priorTotalMinor: withComparative ? priorTotalMinor : null,
  };
}
