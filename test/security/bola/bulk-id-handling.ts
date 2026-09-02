import { buildSourceIndex, type SourceMethod } from "./tenant-binding";

/**
 * A bulk endpoint handed a mixed-tenant id list must fail the whole request.
 * Filtering the list down to the rows the caller owns and reporting success is
 * the defect: the caller is told every id was acted on, and the difference
 * between "not yours" and "already done" becomes an existence oracle.
 *
 * The repository already contains the correct shape, in
 * `projects-tickets-query.service.ts`:
 *
 *   if (found.length !== body.ticketIds.length)
 *     throw new NotFoundException("One or more ticket IDs not found in this project");
 */

/** `inArray(table.column, someIdsVariable)` — a caller-supplied id list reaching a predicate. */
const IN_ARRAY_RE = /\binArray\s*\(\s*[\w.]+\s*,\s*([\w.]+)\s*\)/g;

/** The count comparison that turns a partial match into a refusal. */
const LENGTH_GUARD_RE = /\.length\s*(?:!==|!=|===|==|<|>)\s*[\w.]+\.length\b/;

/**
 * The identifiers a method receives, including the names bound by a destructured
 * parameter. An id list that is NOT one of these was derived inside the method
 * from an already-tenant-scoped query, so a mixed-tenant list cannot reach it and
 * a count check would be meaningless — counting those as defects buries the real
 * ones in noise.
 */
export function parameterNames(signature: string): Set<string> {
  const open = signature.indexOf("(");
  if (open === -1) return new Set();
  const params = signature.slice(open + 1, signature.lastIndexOf(")"));
  const names = new Set<string>();
  for (const m of params.matchAll(/(?:^|[,{(])\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*[?]?\s*[:,}]/g))
    names.add(m[1] as string);
  for (const m of params.matchAll(/\{([^}]*)\}\s*:/g))
    for (const field of (m[1] as string).split(","))
      names.add((field.split(":")[0] ?? "").trim());
  names.delete("readonly");
  return names;
}

export type BulkVerdict = "fail-whole" | "no-count-check" | "not-bulk";

export interface BulkSite {
  readonly owner: string;
  readonly method: string;
  readonly file: string;
  readonly verdict: BulkVerdict;
  readonly idVariables: readonly string[];
}

export function classifyBulkMethod(method: SourceMethod): BulkVerdict {
  const idVariables = [...method.body.matchAll(IN_ARRAY_RE)].map((m) => m[1] as string);
  if (idVariables.length === 0) return "not-bulk";

  const params = parameterNames(method.signature);
  const callerSupplied = idVariables.filter((variable) => {
    const root = variable.split(".")[0] as string;
    const leaf = variable.split(".").at(-1) ?? "";
    return params.has(root) && /[Ii]ds$/.test(leaf);
  });
  if (callerSupplied.length === 0) return "not-bulk";

  return LENGTH_GUARD_RE.test(method.body) ? "fail-whole" : "no-count-check";
}

/**
 * Every service method that pushes a caller-supplied id array into a predicate,
 * with whether it refuses a partial match. Derived from source, so a new bulk
 * endpoint appears here the moment it is written.
 */
export function findBulkSites(): BulkSite[] {
  const index = buildSourceIndex();
  const sites: BulkSite[] = [];
  for (const [className, methods] of index.methodsByClass) {
    if (!className.endsWith("Service")) continue;
    for (const [methodName, method] of methods) {
      const verdict = classifyBulkMethod(method);
      if (verdict === "not-bulk") continue;
      sites.push({
        owner: className,
        method: methodName,
        file: method.file,
        verdict,
        idVariables: [...new Set([...method.body.matchAll(IN_ARRAY_RE)].map((m) => m[1] as string))],
      });
    }
  }
  return sites.sort((a, b) => `${a.owner}.${a.method}`.localeCompare(`${b.owner}.${b.method}`));
}
