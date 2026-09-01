import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { CacheService } from "../../../../common/cache/cache.service";
import type { AiInvokeResult } from "./ai-gateway.types";

const AI_RESPONSE_NAMESPACE = "ai:responses:v1";
const CACHE_TTL_SECONDS = 3_600;

export interface AiCacheParams {
  feature: string;
  tier?: string;
  promptSystem: string;
  promptUser: string;
  aclVersion?: string;
  sourceRevision?: string;
  policy?: string;
}

@Injectable()
export class AiResponseCacheService {
  constructor(private readonly cache: CacheService) {}

  private buildLocalKey(params: AiCacheParams): string {
    const promptHash = createHash("sha256")
      .update(params.promptSystem)
      .update(params.promptUser)
      .digest("hex");
    const parts = [params.feature, params.tier ?? "fast", promptHash];
    if (params.aclVersion) parts.push(`acl:${params.aclVersion}`);
    if (params.sourceRevision) parts.push(`src:${params.sourceRevision}`);
    if (params.policy) parts.push(`pol:${params.policy}`);
    return parts.join(":");
  }

  async cachedInvoke<T>(
    orgId: string,
    params: AiCacheParams,
    fetcher: () => Promise<AiInvokeResult<T>>,
  ): Promise<AiInvokeResult<T>> {
    const localKey = this.buildLocalKey(params);
    return this.cache.cachedVersionedForOrg<AiInvokeResult<T>>(
      orgId,
      AI_RESPONSE_NAMESPACE,
      localKey,
      fetcher,
      CACHE_TTL_SECONDS,
    );
  }

  async invalidate(orgId: string): Promise<void> {
    return this.cache.invalidateNamespaceForOrg(orgId, AI_RESPONSE_NAMESPACE);
  }
}
