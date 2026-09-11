/**
 * Named CSV layouts, as **data**.
 *
 * Every bank ships a different export and the difference is entirely in the
 * column names and the date order. That is configuration, so it lives in a
 * frozen table — adding HDFC or Revolut is a new entry here, never a new
 * `if (bank === ...)` in the importer (PRD 04's "the rails differ,
 * reconciliation does not").
 *
 * A preset is only a starting point: it is copied into the bank profile's
 * `csvMapping` and can be edited per account, because banks change their own
 * headers without telling anybody.
 */
import type { StatementColumnMapping } from "./statement-csv";

export interface StatementMappingPreset {
  code: string;
  label: string;
  /** What a user should recognise the layout by. */
  description: string;
  mapping: StatementColumnMapping;
}

export const STATEMENT_MAPPING_PRESETS: readonly StatementMappingPreset[] = Object.freeze([
  {
    code: "IN_NARRATION_WITHDRAWAL_DEPOSIT",
    label: "India — date / narration / withdrawal / deposit",
    description:
      "The layout most Indian retail and current-account exports use: a narration column and " +
      "separate withdrawal and deposit columns, dates as DD/MM/YYYY.",
    mapping: {
      dateColumn: "Date",
      descriptionColumn: "Narration",
      referenceColumn: "Chq./Ref.No.",
      debitColumn: "Withdrawal Amt.",
      creditColumn: "Deposit Amt.",
      dateFormat: "DD/MM/YYYY",
    },
  },
  {
    code: "US_QBO_THREE_COLUMN",
    label: "US — Date / Description / Amount",
    description:
      "The three-column shape US banks export for QuickBooks: one signed amount column, " +
      "dates as MM/DD/YYYY.",
    mapping: {
      dateColumn: "Date",
      descriptionColumn: "Description",
      referenceColumn: "Reference",
      amountColumn: "Amount",
      dateFormat: "MM/DD/YYYY",
    },
  },
  {
    code: "WISE_MERCURY_SIGNED",
    label: "Wise / Mercury — signed amount with a payment reference",
    description:
      "Neobank exports: one signed amount column, an ISO date, and a payment reference that is " +
      "usually the strongest matching signal in the file.",
    mapping: {
      dateColumn: "Date",
      descriptionColumn: "Description",
      referenceColumn: "Payment Reference",
      amountColumn: "Amount",
      dateFormat: "YYYY-MM-DD",
    },
  },
  {
    code: "EU_SEMICOLON_COMMA_DECIMAL",
    label: "Europe — semicolon separated, comma decimal",
    description:
      "SEPA exports from German and Dutch banks: `;` between fields, `1.234,56` as the amount, " +
      "dates as DD.MM.YYYY.",
    mapping: {
      dateColumn: "Buchungstag",
      descriptionColumn: "Verwendungszweck",
      referenceColumn: "Mandatsreferenz",
      amountColumn: "Betrag",
      dateFormat: "DD.MM.YYYY",
      delimiter: ";",
      decimalSeparator: ",",
    },
  },
]);

const BY_CODE = new Map(STATEMENT_MAPPING_PRESETS.map((p) => [p.code, p]));

export function findMappingPreset(code: string): StatementMappingPreset | undefined {
  return BY_CODE.get(code);
}

export const STATEMENT_MAPPING_PRESET_CODES = STATEMENT_MAPPING_PRESETS.map((p) => p.code);
