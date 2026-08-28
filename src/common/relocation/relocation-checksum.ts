import {
  assertTransitionAllowed,
  type RelocationState,
} from "./relocation-state";

export type ChecksumScope = "table" | "partition" | "object" | "index";

export interface ChecksumEntry {
  readonly scope: ChecksumScope;
  readonly name: string;
  readonly digest: string;
}

export interface ChecksumMismatch {
  readonly scope: ChecksumScope;
  readonly name: string;
  readonly sourceDigest: string;
  readonly targetDigest: string;
}

export type ChecksumComparison =
  | { readonly match: true }
  | { readonly match: false; readonly mismatches: readonly ChecksumMismatch[] };

export function compareChecksums(
  source: readonly ChecksumEntry[],
  target: readonly ChecksumEntry[],
): ChecksumComparison {
  const targetMap = new Map(target.map((e) => [entryKey(e), e]));
  const mismatches: ChecksumMismatch[] = [];

  for (const s of source) {
    const t = targetMap.get(entryKey(s));
    if (t === undefined) {
      mismatches.push({
        scope: s.scope,
        name: s.name,
        sourceDigest: s.digest,
        targetDigest: "<missing>",
      });
      continue;
    }
    if (s.digest !== t.digest)
      mismatches.push({
        scope: s.scope,
        name: s.name,
        sourceDigest: s.digest,
        targetDigest: t.digest,
      });
  }

  for (const t of target) {
    if (!source.some((s) => entryKey(s) === entryKey(t)))
      mismatches.push({
        scope: t.scope,
        name: t.name,
        sourceDigest: "<missing>",
        targetDigest: t.digest,
      });
  }

  if (mismatches.length === 0) return { match: true };
  return { match: false, mismatches };
}

function entryKey(entry: ChecksumEntry): string {
  return `${entry.scope}:${entry.name}`;
}

export function assertChecksumMatch(
  comparison: ChecksumComparison,
  currentState: RelocationState,
): void {
  if (comparison.match) return;
  assertTransitionAllowed(currentState, "FAILED");
  throw new Error(
    `Checksum mismatch on ${comparison.mismatches.length} scope(s). ` +
      `The move must stop and the relocation must be marked FAILED. ` +
      `Mismatches: ${comparison.mismatches.map((m) => m.name).join(", ")}`,
  );
}

export function tableDigestSql(
  schema: string,
  table: string,
  tenantColumn: string,
  orgId: string,
  orderByColumns: readonly string[],
): string {
  const qualifiedTable = `"${schema}"."${table}"`;
  const orderClause = orderByColumns.map((c) => `"${c}"`).join(", ");
  return (
    `SELECT md5(string_agg(row_to_json(t)::text, ',' ORDER BY ${orderClause})) AS digest ` +
    `FROM (SELECT * FROM ${qualifiedTable} WHERE "${tenantColumn}" = '${orgId}' ORDER BY ${orderClause}) t`
  );
}

export function partitionDigestSql(
  schema: string,
  partition: string,
  tenantColumn: string,
  orgId: string,
  orderByColumns: readonly string[],
): string {
  return tableDigestSql(schema, partition, tenantColumn, orgId, orderByColumns);
}

export function objectStorageDigestKey(prefix: string, orgId: string): string {
  return prefix.replace("{orgId}", orgId);
}
