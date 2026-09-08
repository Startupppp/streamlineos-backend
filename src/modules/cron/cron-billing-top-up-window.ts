const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export interface TopUpWindow {
  startUtc: Date;
  endUtc: Date;
  referenceIds: string[];
}

const fmtDate = (d: Date): string =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;

/**
 * The IST calendar day around `now`, and every reference id an auto top-up for
 * `packId` could already carry inside it.
 *
 * IST is +05:30, so an IST day always starts 5h30m before UTC midnight and spans
 * exactly two UTC calendar dates. Manual purchases record `referenceId =
 * String(packId)`; automatic ones record `auto-<packId>-<UTC date>`, so both UTC
 * dates in the window have to be named or a top-up made near UTC midnight reads
 * as absent and the org is charged twice on one IST day.
 */
export function istTopUpWindow(now: Date, packId: number): TopUpWindow {
  const istMirror = new Date(now.getTime() + IST_OFFSET_MS);

  const startUtc = new Date(
    Date.UTC(istMirror.getUTCFullYear(), istMirror.getUTCMonth(), istMirror.getUTCDate()) -
      IST_OFFSET_MS,
  );
  const endUtc = new Date(startUtc.getTime() + 86_400_000);
  const secondUtcDate = new Date(startUtc.getTime() + 6 * 60 * 60 * 1000);

  return {
    startUtc,
    endUtc,
    referenceIds: [
      String(packId),
      `auto-${packId}-${fmtDate(startUtc)}`,
      `auto-${packId}-${fmtDate(secondUtcDate)}`,
    ],
  };
}
