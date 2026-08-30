export interface LegacyActorSnapshot {
  reads: number;
  writes: number;
  total: number;
  byColumn: Readonly<Record<string, { reads: number; writes: number }>>;
  capturedAt: string;
}

let reads = 0;
let writes = 0;
const byColumn: Record<string, { reads: number; writes: number }> = {};

function touch(table: string, column: string, kind: "read" | "write"): void {
  const key = `${table}.${column}`;
  const entry = byColumn[key] ?? { reads: 0, writes: 0 };
  if (kind === "read") entry.reads += 1;
  else entry.writes += 1;
  byColumn[key] = entry;
}

export function recordLegacyActorRead(table: string, column: string): void {
  reads += 1;
  touch(table, column, "read");
}

export function recordLegacyActorWrite(table: string, column: string): void {
  writes += 1;
  touch(table, column, "write");
}

export function snapshotLegacyActorTelemetry(): LegacyActorSnapshot {
  return {
    reads,
    writes,
    total: reads + writes,
    byColumn: Object.fromEntries(
      Object.entries(byColumn).map(([key, counts]) => [key, { ...counts }]),
    ),
    capturedAt: new Date().toISOString(),
  };
}

export function resetLegacyActorTelemetry(): void {
  reads = 0;
  writes = 0;
  for (const key of Object.keys(byColumn)) delete byColumn[key];
}
