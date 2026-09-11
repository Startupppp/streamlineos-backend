import { Injectable } from "@nestjs/common";
import { registerAfterCommit } from "../tenant";
import { CACHE_TTL } from "./cache-keys";
import { CacheService } from "./cache.service";

export interface OrgHierarchyCacheContext {
  // `ScopedRead.discriminator` — already actor-qualified for the scopes that need it.
  discriminator: string;
}

export type OrgHierarchyCacheResource =
  | "overview"
  | `tree:${"ADJACENCY" | "SHADOW_CLOSURE" | "CLOSURE"}:r${number}`;

export interface OrgUnitListQuery {
  status?: string;
  search?: string;
  cursor?: string;
  limit: number;
}

@Injectable()
export class OrgHierarchyCacheService {
  constructor(private readonly cache: CacheService) {}

  read<T>(
    orgId: string,
    resource: OrgHierarchyCacheResource,
    context: OrgHierarchyCacheContext,
    fetcher: () => Promise<T>,
  ): Promise<T> {
    return this.cache.cachedVersionedForOrg(
      orgId,
      "org:hierarchy",
      `${resource}:scope:${context.discriminator}`,
      fetcher,
      CACHE_TTL.LONG,
    );
  }

  readUnitList<T>(
    orgId: string,
    kind: string,
    query: OrgUnitListQuery,
    fetcher: () => Promise<T>,
  ): Promise<T> {
    const filters = JSON.stringify([
      query.status ?? null,
      query.search ?? null,
      query.cursor ?? null,
      query.limit,
    ]);
    return this.cache.cachedVersionedForOrg(
      orgId,
      "org:hierarchy",
      `units:list:${kind}:${filters}`,
      fetcher,
      CACHE_TTL.LONG,
    );
  }

  readUnitGet<T>(
    orgId: string,
    kind: string,
    id: string,
    fetcher: () => Promise<T>,
  ): Promise<T> {
    return this.cache.cachedVersionedForOrg(
      orgId,
      "org:hierarchy",
      `units:get:${kind}:${id}`,
      fetcher,
      CACHE_TTL.LONG,
    );
  }

  async invalidateAfterMutation(orgId: string): Promise<void> {
    const invalidate = () =>
      Promise.all([
        this.cache.invalidateNamespaceForOrg(orgId, "org:hierarchy"),
        this.cache.invalidateNamespaceForOrg(orgId, "hr:headcount"),
        this.cache.invalidateNamespaceForOrg(orgId, "hr:directory"),
      ]).then(() => undefined);

    if (!registerAfterCommit(invalidate)) {
      await invalidate();
    }
  }
}
