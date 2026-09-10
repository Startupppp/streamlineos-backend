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
 * `const missing = ids.filter(id => !found.find(...)); if (missing.length > 0) throw`
 * — the same refusal expressed as a set difference. It names which ids were
 * rejected, which is better code, and counting only the `.length !== .length`
 * form marked `generateRolloutDocuments` as unguarded when it fails the whole
 * request correctly.
 */
const DIFFERENCE_GUARD_RE =
  /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=\s*[^;]*\.filter\([\s\S]*?;[\s\S]{0,400}?\bif\s*\(\s*\1\.length\s*(?:>\s*0|!==\s*0)\s*\)[\s\S]{0,200}?\bthrow\b/;

/** `const someIds = <expr>` / `let someIds = <expr>` — an id list rebound to a local. */
const ID_LOCAL_RE = /\b(?:const|let)\s+([A-Za-z_$][\w$]*[Ii]ds)\s*(?::[^=;]*)?=\s*([^;]*);/g;

/** `this.helper(` — an intra-class call whose callee may hold the count check. */
const THIS_CALL_RE = /\bthis\.(\w+)\s*\(/g;

/**
 * `readMutationTickets(tx, actor, projectId, ticketIds, policy)` — a call to a
 * MODULE-LEVEL function, with its arguments.
 *
 * Following one hop into these is not a nicety. Until 2026-09-10 the scan looked
 * only at a method's own body and at `this.x()` siblings, so extracting a bulk
 * query into an exported function removed the site from the scan **entirely** —
 * `classifyBulkMethod` saw no `inArray` and answered "not-bulk". That is a hole in
 * the gate, not in the code: any bulk endpoint, guarded or not, could be made
 * invisible by a refactor nobody would think to flag. `ProjectsTicketsQueryService
 * .bulkUpdate` is how it was found, when its guard moved to readMutationTickets in
 * build-ticket-mutation-policy.ts and the ratchet dropped 21 -> 20.
 */
const FUNCTION_CALL_RE = /\b([a-z][\w$]*)\s*\(([^()]*)\)/g;

const ID_LEAF_RE = /[Ii]ds$/;

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

/** `input.dealIds` — the id list is a parameter, or a field of one. */
function isParameterSupplied(variable: string, params: ReadonlySet<string>): boolean {
  const root = variable.split(".")[0] as string;
  const leaf = variable.split(".").at(-1) ?? "";
  return params.has(root) && ID_LEAF_RE.test(leaf);
}

function tokensOf(expression: string): string[] {
  return [...expression.matchAll(/[A-Za-z_$][\w$.]*/g)].map((m) => m[0]);
}

/**
 * Locals that carry a caller-supplied id list, followed to a fixed point.
 *
 * Without this, `const requestedIds = [...new Set(input.ids)]` before the
 * predicate hides the site from the scan entirely: the id array's root is then a
 * local rather than a parameter, so a guarded method drops out of the inventory
 * instead of being counted as guarded, and — worse — so does an unguarded one
 * that merely deduplicated its input first.
 */
export function derivedIdLocals(method: {
  readonly signature: string;
  readonly body: string;
}): Set<string> {
  const params = parameterNames(method.signature);
  const derived = new Set<string>();
  const locals = [...method.body.matchAll(ID_LOCAL_RE)].map(
    (m) => [m[1] as string, m[2] as string] as const,
  );
  for (let pass = 0; pass <= locals.length; pass++) {
    let grew = false;
    for (const [name, expression] of locals) {
      if (derived.has(name)) continue;
      const carries = tokensOf(expression).some(
        (token) => isParameterSupplied(token, params) || derived.has(token),
      );
      if (!carries) continue;
      derived.add(name);
      grew = true;
    }
    if (!grew) break;
  }
  return derived;
}

export type BulkVerdict = "fail-whole" | "no-count-check" | "not-bulk";

export interface BulkSite {
  readonly owner: string;
  readonly method: string;
  readonly file: string;
  readonly verdict: BulkVerdict;
  readonly idVariables: readonly string[];
}

/**
 * The count check may live in a private helper the bulk method calls — the
 * property is the same and the code is better. Follow one hop of `this.x()`
 * within the owning class so extracting the guard does not read as removing it.
 */
function guardsInPlace(body: string): boolean {
  return LENGTH_GUARD_RE.test(body) || DIFFERENCE_GUARD_RE.test(body);
}

/**
 * The module-level functions this method hands one of its own id lists to.
 * Only those: a helper called with ids the method derived itself cannot receive a
 * mixed-tenant list, so following it would add noise, not coverage.
 */
function delegatedHelpers(
  method: { readonly signature: string; readonly body: string },
  helpers: ReadonlyMap<string, SourceMethod> | undefined,
  idCandidates: ReadonlySet<string>,
): SourceMethod[] {
  if (!helpers) return [];
  const called: SourceMethod[] = [];
  for (const m of method.body.matchAll(FUNCTION_CALL_RE)) {
    const callee = helpers.get(m[1] as string);
    if (!callee) continue;
    const args = (m[2] ?? "").split(",").map((arg) => arg.trim());
    if (args.some((arg) => idCandidates.has(arg))) called.push(callee);
  }
  return called;
}

function hasCountGuard(
  method: SourceMethod | { readonly body: string },
  siblings?: ReadonlyMap<string, SourceMethod>,
  delegates: readonly SourceMethod[] = [],
): boolean {
  if (guardsInPlace(method.body)) return true;
  if (delegates.some((callee) => guardsInPlace(callee.body))) return true;
  if (!siblings) return false;
  for (const m of method.body.matchAll(THIS_CALL_RE)) {
    const callee = siblings.get(m[1] as string);
    if (callee && guardsInPlace(callee.body)) return true;
  }
  return false;
}

export function classifyBulkMethod(
  method: SourceMethod | { readonly signature: string; readonly body: string },
  siblings?: ReadonlyMap<string, SourceMethod>,
  helpers?: ReadonlyMap<string, SourceMethod>,
): BulkVerdict {
  const params = parameterNames(method.signature);
  const derived = derivedIdLocals(method);
  const callerSupplied = new Set(
    [...params, ...derived].filter((name) => ID_LEAF_RE.test(name)),
  );
  const delegates = delegatedHelpers(method, helpers, callerSupplied);

  const own = [...method.body.matchAll(IN_ARRAY_RE)].map((m) => m[1] as string);
  const reaching = own.filter(
    (variable) => isParameterSupplied(variable, params) || derived.has(variable),
  );

  const delegatedBulk = delegates.some((callee) =>
    [...callee.body.matchAll(IN_ARRAY_RE)].some((m) =>
      isParameterSupplied(m[1] as string, parameterNames(callee.signature)),
    ),
  );

  if (reaching.length === 0 && !delegatedBulk) return "not-bulk";

  return hasCountGuard(method, siblings, delegates) ? "fail-whole" : "no-count-check";
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
      const verdict = classifyBulkMethod(method, methods, index.functions);
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
