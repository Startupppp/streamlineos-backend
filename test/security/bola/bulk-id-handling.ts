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

/**
 * `const allowed = new Set(await filterOrgMemberIds(db, orgId, unique));
 *  if (unique.some((id) => !allowed.has(id))) throw new NotFoundException(…)`
 * — the same refusal again, expressed as set membership instead of a count. `assertUsersInOrg`
 * (`common/tenant/org-membership.ts`) is the shape, and it refuses the WHOLE request with a 404,
 * which is exactly what this gate asks for; counting only the two arithmetic forms reported every
 * caller of it as unguarded.
 */
const SET_MEMBERSHIP_GUARD_RE =
  /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*new Set\([\s\S]{0,400}?\bif\s*\(\s*[\w.]+\.some\([\s\S]{0,120}?!\s*\1\.has\([\s\S]{0,200}?\bthrow\b/;

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
  return (
    LENGTH_GUARD_RE.test(body) ||
    DIFFERENCE_GUARD_RE.test(body) ||
    SET_MEMBERSHIP_GUARD_RE.test(body)
  );
}

/**
 * A signature's parameters by position — `""` for a destructured slot, which has no single name
 * a carrier could arrive under. `parameterNames` answers "which names", this answers "which slot".
 */
function positionalParameters(signature: string): string[] {
  const open = signature.indexOf("(");
  const close = signature.lastIndexOf(")");
  if (open === -1 || close <= open) return [];
  const inner = signature.slice(open + 1, close);
  const slots: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= inner.length; i++) {
    const ch = inner[i];
    if (ch === "(" || ch === "{" || ch === "[" || ch === "<") depth += 1;
    else if (ch === ")" || ch === "}" || ch === "]" || (ch === ">" && inner[i - 1] !== "=")) depth -= 1;
    else if (i === inner.length || (ch === "," && depth === 0)) {
      const part = inner.slice(start, i).trim();
      if (part.length > 0)
        slots.push(/^(?:(?:public|private|protected|readonly)\s+)*([A-Za-z_$][\w$]*)/.exec(part)?.[1] ?? "");
      start = i + 1;
    }
  }
  return slots;
}

/**
 * The module-level functions this method hands one of its own id lists to.
 * Only those: a helper called with ids the method derived itself cannot receive a
 * mixed-tenant list, so following it would add noise, not coverage.
 *
 * "Its own id list" includes the two shapes a split by responsibility produces, both of which
 * used to drop a site from the scan entirely: a field of a parameter passed on
 * (`assertGroupsBelongToModule(deps, orgId, key, input.groupIds)`), and a whole parameter
 * forwarded as a carrier whose `<param>.<…Ids>` the callee then pushes into `inArray`
 * (`return bulkDelete(this.bulkDeps, orgId, userId, input)`). The carrier is followed only into
 * the callee slot it lands in, so a forwarded `orgId` never makes an unrelated list count.
 */
function delegatedHelpers(
  method: { readonly signature: string; readonly body: string },
  helpers: ReadonlyMap<string, SourceMethod> | undefined,
  idCandidates: ReadonlySet<string>,
): SourceMethod[] {
  if (!helpers) return [];
  const params = parameterNames(method.signature);
  const called: SourceMethod[] = [];
  for (const m of method.body.matchAll(FUNCTION_CALL_RE)) {
    const callee = helpers.get(m[1] as string);
    if (!callee) continue;
    const args = (m[2] ?? "").split(",").map((arg) => arg.trim());
    if (args.some((arg) => idCandidates.has(arg) || isParameterSupplied(arg, params))) {
      called.push(callee);
      continue;
    }
    const slots = positionalParameters(callee.signature);
    const calleeLists = [...callee.body.matchAll(IN_ARRAY_RE)].map((x) => x[1] as string);
    const carried = args.some((arg, slot) => {
      const landing = slots[slot];
      if (!params.has(arg) || !landing) return false;
      return calleeLists.some(
        (list) => list.startsWith(`${landing}.`) && ID_LEAF_RE.test(list.split(".").at(-1) ?? ""),
      );
    });
    if (carried) called.push(callee);
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
