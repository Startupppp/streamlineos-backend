import { fail } from "./bundle-error";

export type CatalogVerificationMode = "initial-apply" | "verified-existing";

type RangeChild = { child_name: string; partition_bound: string };
type ExpectedRangeChild = { name: string; bound: string };

export function assertExactRangeChildren(
  actual: RangeChild[],
  expected: ExpectedRangeChild[],
): void {
  const actualRows = actual
    .map((child) => `${child.child_name}:${child.partition_bound}`)
    .sort();
  const expectedRows = expected
    .map((child) => `${child.name}:${child.bound}`)
    .sort();
  if (
    actualRows.length !== expectedRows.length ||
    actualRows.some((value, index) => value !== expectedRows[index])
  )
    fail("RUNNER_CATALOG_PARTITION_MISMATCH");
}

export function assertRangeChildren(
  actual: RangeChild[],
  expected: ExpectedRangeChild[],
  mode: CatalogVerificationMode,
): void {
  if (actual.some((child) => child.partition_bound.toUpperCase() === "DEFAULT"))
    fail("RUNNER_CATALOG_DEFAULT_PARTITION");
  if (mode === "initial-apply") assertExactRangeChildren(actual, expected);
}
