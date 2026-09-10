import type { ScopePredicate } from "./access.types";
import { applyScope, type ScopeColumns } from "./apply-scope";
import type { DataScope } from "./access.types";

export interface ObjectAccessContext {
  orgId: string;
  actorId: string;
  scope: DataScope;
}

type ObjectQuery<T> = (ctx: ObjectAccessContext) => Promise<T | null>;

interface ScopeSource {
  resolveUserPermissions(
    orgId: string,
    userId: string,
  ): Promise<ReadonlyMap<string, DataScope>>;
}

// A resolved DataScope whose only exit is predicate(), so it cannot be held and not spent.
export class ScopedRead {
  // A `#` field, not `private`: TypeScript's `private` is erased at runtime.
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

  // An unheld or mistyped key yields none, whose predicate is false.
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

  // Named for what it is: a cache discriminator is not a filter.
  get discriminator(): string {
    return this.#scope;
  }

  /** The only way out. */
  predicate(cols: ScopeColumns): ScopePredicate {
    return applyScope(this.#scope, this.orgId, this.actorId, cols);
  }

  // The escape hatch, for a domain predicate that branches on the value itself.
  context(): ObjectAccessContext {
    return { orgId: this.orgId, actorId: this.actorId, scope: this.#scope };
  }
}
