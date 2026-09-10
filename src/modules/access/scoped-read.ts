import { and, eq, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { applyScope, type ScopeColumns } from "./apply-scope";
import type { DataScope } from "./access.types";

// The class binding is not exported and the private field makes it nominal, so no other file can produce one.
class ScopedWhereToken {
  private readonly tenantAndScopeInstalled = true;

  constructor(readonly sql: SQL) {}
}

export type ScopedWhere = ScopedWhereToken;

export interface ScopeActor {
  orgId: string;
  userId: string;
}

export type ScopeShape = { columns: ScopeColumns } | { own: SQL; team?: SQL };

export interface ScopedWhereSpec {
  tenant: PgColumn;
  scope: ScopeShape;
  and?: readonly (SQL | undefined)[];
}

interface ScopeForSource<A extends ScopeActor> {
  scopeFor(actor: A, permissionKey: string): Promise<DataScope>;
}

export class ScopedRead {
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

  static async for<A extends ScopeActor>(
    access: ScopeForSource<A>,
    actor: A,
    permissionKey: string,
  ): Promise<ScopedRead> {
    return new ScopedRead(actor.orgId, actor.userId, await access.scopeFor(actor, permissionKey));
  }

  get denied(): boolean {
    return this.#scope === "none";
  }

  // own and team select different rows per person, so the actor is part of the cache discriminator.
  get discriminator(): string {
    if (this.#scope === "all" || this.#scope === "none") return this.#scope;
    return `${this.#scope}:${this.actorId}`;
  }

  async read<T>(
    spec: ScopedWhereSpec,
    run: (where: ScopedWhere) => Promise<T>,
    whenDenied: () => T | Promise<T>,
  ): Promise<T> {
    if (this.#scope === "none") return whenDenied();
    return run(this.#where(spec));
  }

  compose<T>(spec: ScopedWhereSpec, build: (where: ScopedWhere) => T, whenDenied: () => T): T {
    if (this.#scope === "none") return whenDenied();
    return build(this.#where(spec));
  }

  // The named escape hatch; every call site is enumerated with its reason in check-scope-boundary.mjs.
  rawScope(reason: string): DataScope {
    void reason;
    return this.#scope;
  }

  #where(spec: ScopedWhereSpec): ScopedWhereToken {
    const domain = (spec.and ?? []).filter((clause): clause is SQL => clause !== undefined);
    const parts: SQL[] = [eq(spec.tenant, this.orgId), this.#predicate(spec.scope), ...domain];
    return new ScopedWhereToken(and(...parts) ?? sql`false`);
  }

  #predicate(shape: ScopeShape): SQL {
    if ("columns" in shape) return applyScope(this.#scope, this.orgId, this.actorId, shape.columns);
    switch (this.#scope) {
      case "all":
        return sql`true`;
      case "team":
        return shape.team ?? shape.own;
      case "own":
        return shape.own;
      case "none":
        return sql`false`;
      default: {
        void (this.#scope satisfies never);
        return sql`false`;
      }
    }
  }
}
