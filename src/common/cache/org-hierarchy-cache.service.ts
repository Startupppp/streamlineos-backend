import { Injectable } from "@nestjs/common";
import type { DataScope } from "../../modules/access/access.types";
import { registerAfterCommit } from "../tenant";
import { CACHE_KEYS, CACHE_TTL } from "./cache-keys";
import { CacheService } from "./cache.service";

export interface OrgHierarchyCacheContext {
  actorUserId: string;
  scope: DataScope;
}

export type OrgHierarchyCacheResource =
  | "overview"
  | `tree:${"ADJACENCY" | "SHADOW_CLOSURE" | "CLOSURE"}:r${number}`;

@Injectable()
export class OrgHierarchyCacheService {
  constructor(private readonly cache: CacheService) {}

  read<T>(
    orgId: string,
    resource: OrgHierarchyCacheResource,
    context: OrgHierarchyCacheContext,
    fetcher: () => Promise<T>,
  ): Promise<T> {
    return this.cache.cachedVersioned(
      CACHE_KEYS.orgHierarchyNamespace(orgId),
      `${resource}:${this.viewerKey(context)}`,
      fetcher,
      CACHE_TTL.LONG,
    );
  }

  async invalidateAfterMutation(orgId: string): Promise<void> {
    const invalidate = () =>
      Promise.all([
        this.cache.invalidateNamespace(
          CACHE_KEYS.orgHierarchyNamespace(orgId),
        ),
        this.cache.invalidateNamespace(CACHE_KEYS.hrHeadcountNamespace(orgId)),
      ]).then(() => undefined);

    if (!registerAfterCommit(invalidate)) {
      await invalidate();
    }
  }

  private viewerKey(context: OrgHierarchyCacheContext): string {
    if (context.scope === "all") return "scope:all";
    return `scope:${context.scope}:actor:${context.actorUserId}`;
  }
}
