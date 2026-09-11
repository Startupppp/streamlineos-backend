import type { MappedRow } from "../sign-bulk-send.types";

/**
 * One row, so the worker can re-derive a row from what was stored rather
 * than from what the request happened to be holding. `mapRows` used to be
 * the only mapper and the mapped values lived in memory for the life of the
 * request — which is fine when the request also does the sending, and
 * impossible once the sending moves to a worker that may run minutes later
 * in another process.
 */
export function mapRow(
  raw: Record<string, unknown>,
  columnMapping: Record<string, string>,
  rowNumber: number,
): MappedRow {
  const nameCol = columnMapping.name;
  const emailCol = columnMapping.email;
  const phoneCol = columnMapping.phone;
  const name = nameCol ? String(raw[nameCol] ?? "").trim() : "";
  const email = emailCol ? String(raw[emailCol] ?? "").trim() : "";
  const phone = phoneCol ? String(raw[phoneCol] ?? "").trim() : undefined;

  let error: string | undefined;
  if (!name) error = "Missing name";
  else if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) error = "Missing or invalid email";

  return { rowNumber, raw, name: name || undefined, email: email || undefined, phone, error };
}

export function mapRows(rows: Record<string, unknown>[], columnMapping: Record<string, string>): MappedRow[] {
  return rows.map((raw, index) => mapRow(raw, columnMapping, index + 1));
}
