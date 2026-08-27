import type { SQL } from "drizzle-orm";
import { applyScope, type ScopeColumns } from "./apply-scope";
import type { DataScope } from "./access.types";

export interface ObjectAccessContext {
  orgId: string;
  actorId: string;
  scope: DataScope;
}

export type ObjectQuery<T> = (ctx: ObjectAccessContext) => Promise<T | null>;

interface ScopeSource {
  resolveUserPermissions(
    orgId: string,
    userId: string,
  ): Promise<ReadonlyMap<string, DataScope>>;
}

/**
 * A resolved DataScope that can only be spent as a SQL predicate.
 *
 * The defect this exists to make unrepresentable is not a missing check, it is a
 * present one that does nothing. `LeavesService.analytics` resolved the caller's
 * scope, refused only `"none"`, put the scope in its cache key, and then called
 * a query that takes no scope and aggregates the whole organisation. Every
 * reviewer who read it saw scope handling and stopped. A plain `DataScope` makes
 * that possible because it is an ordinary string: you can hold one, look at it,
 * and never let it near the query.
 *
 * `ScopedRead` has no accessor for the scope. `predicate()` is the only exit,
 * and it returns SQL, so the value cannot be carried anywhere except into a
 * WHERE clause. Two consequences follow, and both are the point:
 *
 *   - **Forgetting to refuse `none` is no longer possible.** `applyScope`
 *     already renders `none` as `false`, so a caller who uses the predicate is
 *     denied by the predicate. Today the `=== "none"` guard is the only thing
 *     most call sites do, and it is the half that does not matter.
 *   - **A cache key cannot masquerade as a filter.** `discriminator` exists and
 *     is named for what it is, so `${scope}:${year}` in a cache key stays
 *     visible as a cache key rather than reading like scope handling.
 *
 * It composes rather than abstracts: `ScopeColumns` are the domain's own
 * columns, each domain still writes its own query, and no table name is ever
 * passed as a value. `pnpm check:scope-application` names the call sites that
 * still resolve a bare `DataScope`.
 */
export class ScopedRead {
  // A `#` field, not `private`: TypeScript's `private` is erased, so the scope
  // would still be an own property anyone could read off the instance and the
  // guarantee above would hold only until someone spread it.
  readonly #scope: DataScope;

  private constructor(
    readonly orgId: string,
    readonly actorId: string,
    scope: DataScope,
  ) {
    this.#scope = scope;
  }

  static of(orgId: string, actorId: string, scope: DataScope): ScopedRead {
    return new ScopedRead(orgId, actorId, scope);
  }

  /**
   * Resolve `permissionKey` for the actor. An unheld key yields `none`, whose
   * predicate is `false`, so the failure mode of a typo is an empty result set
   * rather than an unfiltered one.
   */
  static async resolve(
    access: ScopeSource,
    actor: { orgId: string; userId: string },
    permissionKey: string,
  ): Promise<ScopedRead> {
    const resolved = await access.resolveUserPermissions(actor.orgId, actor.userId);
    return new ScopedRead(actor.orgId, actor.userId, resolved.get(permissionKey) ?? "none");
  }

  /** True when the caller holds nothing. Refusing early is an optimisation, never the check. */
  get denied(): boolean {
    return this.#scope === "none";
  }

  /**
   * A cache-key segment. Named for what it is so it can never be mistaken for
   * the filter: it makes a cache finer than its data, which hides nothing.
   */
  get discriminator(): string {
    return this.#scope;
  }

  /** The only way out. */
  predicate(cols: ScopeColumns): SQL {
    return applyScope(this.#scope, this.orgId, this.actorId, cols);
  }

  /**
   * The per-domain query context. `scope` is exposed here only because a domain
   * predicate builder that branches on it (leave approvals do) needs the value;
   * reach for `predicate()` first, and treat this as the escape hatch it is.
   */
  context(): ObjectAccessContext {
    return { orgId: this.orgId, actorId: this.actorId, scope: this.#scope };
  }
}
