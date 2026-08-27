import type { DataScope } from "../../access/access.types";
import { QueryCompilationError } from "./errors";
import { quoteIdent, type ParamBag } from "./emit";
import { BASE_ALIAS, type SourceSpec } from "./registry";

/**
 * The requester's data scope, emitted as a predicate the description cannot see.
 *
 * The organisation predicate answers "whose data"; this answers "which of it".
 * `crm:deals:read` is a `scopable` permission — a sales rep may hold it as
 * `own`, meaning the deals assigned to them — and every list screen in the
 * product honours that through `applyScope`. Until this file existed, reporting
 * did not: the module checked that the key was *held* and dropped the scope on
 * the floor, so the one surface that can total an entire pipeline was also the
 * one surface that ignored the narrowing. That widening was recorded in code as
 * `REPORTING_SCOPE_GAP` rather than left to be discovered; this file is what
 * closed it, and `REPORTING_SCOPE_RULE` is what replaced the note.
 *
 * ## Why the compiler and not the description
 *
 * The same argument as the tenant predicate, and it is worth restating because
 * it is the whole design. A predicate a *description* supplies is a predicate a
 * description can omit — and descriptions here are tenant-authored, stored for
 * months, replayed by other people, and merged with overrides on the way out. So
 * the scope is not a filter the caller is trusted to include, and not a default
 * the caller may override: it is a term `compileQuery` appends to every
 * statement it emits, after the description has had its say. There is no
 * description that compiles without it, because there is nothing in
 * `QueryDescription` that can talk about it.
 *
 * ## Why this is `DataScope` and not a new vocabulary
 *
 * `DataScope` is the product's existing answer to "how much may this person
 * see", resolved by `AccessService` from the grant's own `scope` column and
 * applied everywhere else by `access/apply-scope.ts`. A reporting-specific scope
 * enum would mean a rep whose deals list shows twelve rows can produce a report
 * over four hundred, and neither number would be wrong by its own rules. The
 * semantics below mirror `applyScope` case for case — `all` is `TRUE`, `own` is
 * ownership by the requester, `team` is that plus everyone sharing a TEAM
 * org-unit, `none` is `FALSE` — because two implementations of "team" that
 * disagree is worse than one that is imperfect.
 *
 * They cannot be the *same* implementation: `applyScope` builds a Drizzle `SQL`
 * from `PgColumn` objects, and this compiler emits text with `$n` placeholders
 * precisely so its output can be asserted on, stored in an audit row, and read
 * by a person who does not trust it. So the shape is re-emitted here and
 * `scope.spec.ts` pins it against `applyScope`'s structure rather than against a
 * snapshot of this file's output.
 */

/** Who is asking, and how much of the tenant's data they may see. */
export interface RequesterScope {
  /** The requesting user. Consulted only where the scope narrows. */
  readonly userId: string;
  /** Resolved from the source's own permission grant — see `reporting-scope.ts`. */
  readonly scope: DataScope;
}

/**
 * Every `DataScope`, as a value the runtime can check against.
 *
 * A `Record<DataScope, true>` rather than an array, for one reason that is worth
 * the odd shape: the record is exhaustive by construction. Adding a fifth member
 * to `DataScope` in `access.types.ts` makes this object a type error here, so the
 * new member cannot arrive in this module as a string nothing recognises. An
 * array typed `readonly DataScope[]` would accept three of the four and compile.
 *
 * It is checked at all because `TypeScript is not present at runtime` applies to
 * the scope exactly as it applies to the description: a `DataScope` reaches this
 * compiler from `AccessService`, which reads it from a `scope` column that an
 * administrator's SQL, a migration, or a future grant editor could put anything
 * into. A scope this compiler does not recognise must be a refusal, never a
 * fall-through — and `compileScopePredicate`'s `never` arm is a *type*
 * exhaustiveness check, which is precisely the thing that does not run.
 */
const DATA_SCOPE_MEMBERS: Record<DataScope, true> = {
  all: true,
  team: true,
  own: true,
  none: true,
};

/**
 * `hasOwnProperty`, not `in` and not a truthy index.
 *
 * `DATA_SCOPE_MEMBERS["constructor"]` is a function and therefore truthy, so a
 * grant whose scope column said `constructor` would pass a naive check and reach
 * the `switch` — which would fall to the `never` arm and, in a version of this
 * file written slightly less carefully, to whatever it returned last. The
 * registry avoids the same prototype hit by being a `Map`; this object is small
 * and fixed, so an own-property check is the cheaper equivalent.
 */
export function isDataScope(value: unknown): value is DataScope {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(DATA_SCOPE_MEMBERS, value)
  );
}

/**
 * The requester, validated, or a refusal.
 *
 * Called by `compileQuery` before anything is emitted, so that "every compiled
 * statement carries a scope term this compiler understands" is true of the
 * output rather than of the happy path. The refusal is a
 * `QueryCompilationError` like every other, because the caller of the compiler
 * is the service and it already turns those into a 400 — an unrecognised scope
 * is a misconfiguration and the person running the report should be told the
 * report was refused, not handed rows compiled under a scope nobody defined.
 */
export function assertRequesterScope(value: unknown): RequesterScope {
  if (value === null || typeof value !== "object")
    throw new QueryCompilationError(
      "malformed_description",
      "compileQuery requires a requester",
      "requester",
    );

  const scope = (value as { scope?: unknown }).scope;
  if (!isDataScope(scope))
    throw new QueryCompilationError(
      "malformed_description",
      `unknown data scope ${JSON.stringify(scope)}`,
      "requester.scope",
    );

  return value as RequesterScope;
}

/**
 * Aliases used inside the scope subquery.
 *
 * Prefixed rather than short, because they share a namespace with the registry's
 * join aliases. A scope alias colliding with `BASE_ALIAS` would shadow the base
 * table *inside the subquery* — the predicate would then read ownership from the
 * wrong relation and still return rows, which is the failure mode that does not
 * announce itself. `scope.spec.ts` asserts no registry join can take one of
 * these names.
 */
export const SCOPE_TEAMMATE_ALIAS = "scope_teammate";
export const SCOPE_PEER_UNIT_ALIAS = "scope_peer_unit";
export const SCOPE_UNIT_ALIAS = "scope_unit";
export const SCOPE_ALIASES = [
  SCOPE_TEAMMATE_ALIAS,
  SCOPE_PEER_UNIT_ALIAS,
  SCOPE_UNIT_ALIAS,
] as const;

/**
 * The membership tables the `team` scope resolves against.
 *
 * Named here as constants and emitted through `quoteIdent` like every other
 * identifier in this module. They are `org_unit_members` and `org_units` because
 * that is what `applyScope` reads; the column names are `org_units.id`,
 * `org_units.kind`, `org_unit_members.org_id|org_unit_id|user_id`.
 */
const ORG_UNIT_MEMBERS_TABLE = "org_unit_members";
const ORG_UNITS_TABLE = "org_units";
const ORG_UNITS_ID = "id";
const ORG_UNITS_ORG = "org_id";
const ORG_UNITS_KIND = "kind";
const MEMBERS_ORG = "org_id";
const MEMBERS_UNIT = "org_unit_id";
const MEMBERS_USER = "user_id";

/**
 * Which org-unit kind counts as a team.
 *
 * Bound as a parameter, not written into the statement. `'TEAM'` in the text
 * would be the single quote this compiler otherwise never emits, and the
 * absence of that one character is what makes "this statement contains no
 * literals" checkable by anybody, without reading the compiler. A constant is
 * not the exception; there is no exception.
 */
const TEAM_UNIT_KIND = "TEAM";

const qualified = (alias: string, column: string): string =>
  `${quoteIdent(alias)}.${quoteIdent(column)}`;

/**
 * The scope term for one compiled statement. Never empty, never optional.
 *
 * `all` emits `true` rather than nothing. Emitting nothing would be equivalent
 * SQL and a worse artefact: the audit row would carry a statement from which the
 * scope decision is unrecoverable, and "every compiled statement carries a scope
 * term" would become a claim about a branch rather than one a reader can check
 * against the text. The planner discards a constant `true` before it costs
 * anything.
 */
export function compileScopePredicate(
  source: SourceSpec,
  requester: RequesterScope,
  params: ParamBag,
  orgParam: string,
): string {
  const scope = requester.scope;

  if (scope === "all") return "true";
  /**
   * `none` is the resolved answer for a key the caller does not hold, and for a
   * personal access token that was never delegated the source's permission. It
   * is `false`, matching `applyScope` — not a thrown error, because the two say
   * different things: the caller may run reports, and this one returns nothing.
   */
  if (scope === "none") return "false";

  const ownership = source.ownership;
  if (ownership.kind === "unowned")
    /**
     * A narrowing was asked for and the source cannot express it. Fails closed:
     * no row of a source with no owner is anybody's, so a narrowed requester
     * sees none of it. The alternative — widening to `true` because the
     * narrowing is inexpressible — is how "we could not apply your scope" turns
     * into "so we ignored it", which is the bug this whole file exists to
     * remove.
     */
    return "false";

  const userParam = params.bind(requireUserId(requester));
  const owner = qualified(BASE_ALIAS, ownership.column);
  const own = `${owner} = ${userParam}`;

  if (scope === "own") return own;
  if (scope === "team") return `(${own} OR ${owner} IN ${teammateUserIds(orgParam, userParam, params)})`;

  /**
   * Unreachable while `DataScope` has four members, and it is a `never` binding
   * so that adding a fifth is a type error here rather than a silent fall
   * through to whatever this function returns last. The runtime arm still fails
   * closed, because a compiler that returns `true` for a scope it does not
   * recognise is a compiler that widens on the day somebody extends the enum.
   */
  const exhaustive: never = scope;
  void exhaustive;
  return "false";
}

/**
 * Everyone sharing at least one TEAM org-unit with the requester.
 *
 * Structurally identical to `teammateUserIds` in `access/apply-scope.ts` — same
 * tables, same three org predicates, same `kind = 'TEAM'` restriction — and that
 * is the point: "my team" must mean one thing across the product. The org
 * predicate appears on both membership relations and on `org_units` for the same
 * reason it does in `apply-scope.ts`: these tables are tenant-scoped and a
 * subquery that omitted it would resolve teammates across organisations.
 */
function teammateUserIds(orgParam: string, userParam: string, params: ParamBag): string {
  const teamKindParam = params.bind(TEAM_UNIT_KIND);
  const teammate = SCOPE_TEAMMATE_ALIAS;
  const peer = SCOPE_PEER_UNIT_ALIAS;
  const unit = SCOPE_UNIT_ALIAS;

  const peerUnits = [
    `SELECT ${qualified(peer, MEMBERS_UNIT)}`,
    `FROM ${quoteIdent(ORG_UNIT_MEMBERS_TABLE)} AS ${quoteIdent(peer)}`,
    `JOIN ${quoteIdent(ORG_UNITS_TABLE)} AS ${quoteIdent(unit)}`,
    `ON ${qualified(unit, ORG_UNITS_ID)} = ${qualified(peer, MEMBERS_UNIT)}`,
    `WHERE ${qualified(peer, MEMBERS_ORG)} = ${orgParam}`,
    `AND ${qualified(peer, MEMBERS_USER)} = ${userParam}`,
    `AND ${qualified(unit, ORG_UNITS_ORG)} = ${orgParam}`,
    `AND ${qualified(unit, ORG_UNITS_KIND)} = ${teamKindParam}`,
  ].join(" ");

  return [
    `(SELECT ${qualified(teammate, MEMBERS_USER)}`,
    `FROM ${quoteIdent(ORG_UNIT_MEMBERS_TABLE)} AS ${quoteIdent(teammate)}`,
    `WHERE ${qualified(teammate, MEMBERS_ORG)} = ${orgParam}`,
    `AND ${qualified(teammate, MEMBERS_UNIT)} IN (${peerUnits}))`,
  ].join(" ");
}

/**
 * The requester's id, or a refusal.
 *
 * Checked where it is consulted rather than at the top of the compiler, because
 * `all` and `none` never read it — and demanding an id from a caller whose scope
 * does not use one would force a system-initiated run to invent one. An invented
 * id inside an ownership predicate is worse than an absent one: it matches
 * whatever row happens to carry it.
 *
 * An empty string is refused for the same reason `organizationId` is: it would
 * compile to `owner = $2` with `$2` empty, a predicate that matches nothing
 * today and would match rows with an empty owner column tomorrow.
 */
function requireUserId(requester: RequesterScope): string {
  if (typeof requester.userId !== "string" || requester.userId.length === 0)
    throw new QueryCompilationError(
      "malformed_description",
      `a ${requester.scope} scope needs the requesting user, but none was supplied`,
      "requester.userId",
    );
  return requester.userId;
}
