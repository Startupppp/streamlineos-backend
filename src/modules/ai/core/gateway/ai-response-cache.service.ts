import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { CacheService } from "../../../../common/cache/cache.service";
import type { AiInvokeFailure, AiInvokeResult } from "./ai-gateway.types";

const AI_RESPONSE_NAMESPACE = "ai:responses:v1";
const CACHE_TTL_SECONDS = 3_600;

class UncacheableAiFailure extends Error {
  constructor(readonly outcome: AiInvokeFailure) {
    super("ai invoke failed");
  }
}

export interface AiCacheParams {
  feature: string;
  tier?: string;
  promptSystem: string;
  promptUser: string;
  aclVersion: string;
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
    const parts = [
      params.feature,
      params.tier ?? "fast",
      promptHash,
      `acl:${params.aclVersion}`,
    ];
    if (params.sourceRevision) parts.push(`src:${params.sourceRevision}`);
    if (params.policy) parts.push(`pol:${params.policy}`);
    return parts.join(":");
  }

  async cachedInvoke<T>(
    orgId: string,
    params: AiCacheParams,
    fetcher: () => Promise<AiInvokeResult<T>>,
  ): Promise<AiInvokeResult<T>> {
    if (!params.aclVersion)
      throw new Error(
        "AI response caching requires an aclVersion — an ACL-blind key serves restricted content to the next reader",
      );

    const localKey = this.buildLocalKey(params);

    try {
      return await this.cache.cachedVersionedForOrg<AiInvokeResult<T>>(
        orgId,
        AI_RESPONSE_NAMESPACE,
        localKey,
        async () => {
          const outcome = await fetcher();
          if (!outcome.ok) throw new UncacheableAiFailure(outcome);
          return outcome;
        },
        CACHE_TTL_SECONDS,
      );
    } catch (error) {
      if (error instanceof UncacheableAiFailure) return error.outcome;
      throw error;
    }
  }

  async invalidate(orgId: string): Promise<void> {
    return this.cache.invalidateNamespaceForOrg(orgId, AI_RESPONSE_NAMESPACE);
  }
}
