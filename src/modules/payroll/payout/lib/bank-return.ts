/**
 * Bank return / ack file parser (export-manual honesty).
 * Accepts a simple CSV; does not talk to bank networks.
 *
 * Supported columns (header row, case-insensitive):
 * - itemId (preferred) OR userId
 * - status: PAID | FAILED | RETURNED (RETURNED → FAILED)
 * - transactionRef / utr / ref (optional for PAID)
 * - failureReason / reason (optional for FAILED)
 */

export type BankReturnStatus = "PAID" | "FAILED";

export interface BankReturnLine {
  itemId: number | null;
  userId: string | null;
  status: BankReturnStatus;
  transactionRef: string | null;
  failureReason: string | null;
  rawLine: number;
}

export interface BankReturnParseResult {
  lines: BankReturnLine[];
  errors: { line: number; message: string }[];
  format: "csv";
  mode: "export_manual";
  honestyNote: string;
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

function mapStatus(raw: string): BankReturnStatus | null {
  const s = raw.trim().toUpperCase();
  if (s === "PAID" || s === "SUCCESS" || s === "CREDITED") return "PAID";
  if (s === "FAILED" || s === "RETURNED" || s === "REJECTED" || s === "BOUNCED") return "FAILED";
  return null;
}

/**
 * Parse bank return CSV into structured update lines.
 */
export function parseBankReturnCsv(csvText: string): BankReturnParseResult {
  const honestyNote =
    "Bank return import is a manual CSV workflow. StreamlineOS does not connect to NEFT/RTGS/ACH networks.";
  const errors: { line: number; message: string }[] = [];
  const lines: BankReturnLine[] = [];

  const rawLines = csvText
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (rawLines.length === 0) {
    return {
      lines: [],
      errors: [{ line: 0, message: "Empty file" }],
      format: "csv",
      mode: "export_manual",
      honestyNote,
    };
  }

  const headerCells = splitCsvLine(rawLines[0]).map(normalizeHeader);
  const idx = {
    itemId: headerCells.findIndex((h) => h === "itemid" || h === "id" || h === "batchitemid"),
    userId: headerCells.findIndex((h) => h === "userid" || h === "employeeid" || h === "empid"),
    status: headerCells.findIndex((h) => h === "status" || h === "result" || h === "paymentstatus"),
    ref: headerCells.findIndex(
      (h) =>
        h === "transactionref" ||
        h === "txnref" ||
        h === "utr" ||
        h === "ref" ||
        h === "reference",
    ),
    reason: headerCells.findIndex(
      (h) => h === "failurereason" || h === "reason" || h === "error" || h === "remarks",
    ),
  };

  if (idx.status < 0) {
    return {
      lines: [],
      errors: [{ line: 1, message: "Missing status column (status / result / paymentStatus)" }],
      format: "csv",
      mode: "export_manual",
      honestyNote,
    };
  }
  if (idx.itemId < 0 && idx.userId < 0) {
    return {
      lines: [],
      errors: [{ line: 1, message: "Need itemId or userId column to match payout items" }],
      format: "csv",
      mode: "export_manual",
      honestyNote,
    };
  }

  for (let i = 1; i < rawLines.length; i++) {
    const lineNo = i + 1;
    const cells = splitCsvLine(rawLines[i]);
    const statusRaw = cells[idx.status] ?? "";
    const status = mapStatus(statusRaw);
    if (!status) {
      errors.push({ line: lineNo, message: `Invalid status "${statusRaw}"` });
      continue;
    }

    let itemId: number | null = null;
    if (idx.itemId >= 0) {
      const n = parseInt(cells[idx.itemId] ?? "", 10);
      if (!Number.isFinite(n) || n <= 0) {
        errors.push({ line: lineNo, message: `Invalid itemId "${cells[idx.itemId] ?? ""}"` });
        continue;
      }
      itemId = n;
    }

    const userId =
      idx.userId >= 0 && (cells[idx.userId] ?? "").trim()
        ? (cells[idx.userId] ?? "").trim()
        : null;

    const transactionRef =
      idx.ref >= 0 && (cells[idx.ref] ?? "").trim() ? (cells[idx.ref] ?? "").trim() : null;
    const failureReason =
      idx.reason >= 0 && (cells[idx.reason] ?? "").trim()
        ? (cells[idx.reason] ?? "").trim()
        : null;

    if (status === "PAID" && !transactionRef) {
      errors.push({
        line: lineNo,
        message: "PAID rows require transactionRef / utr / ref",
      });
      continue;
    }
    if (status === "FAILED" && !failureReason) {
      // allow default reason
    }

    lines.push({
      itemId,
      userId,
      status,
      transactionRef,
      failureReason: status === "FAILED" ? failureReason || "Bank return failed" : null,
      rawLine: lineNo,
    });
  }

  return { lines, errors, format: "csv", mode: "export_manual", honestyNote };
}
