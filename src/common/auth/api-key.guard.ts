import {
  CanActivate, ExecutionContext, ForbiddenException, HttpException, HttpStatus, Inject, Injectable, UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import { createHash } from "crypto";
import { and, eq } from "drizzle-orm";
import { apiKeys } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { RateLimitService } from "../ratelimit/rate-limit.service";
import type { ApiKeyContext } from "./api-key.decorator";

const REQUIRED_SCOPES = ["leads:write", "leads:*", "*"];

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly rateLimit: RateLimitService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { apiKey?: ApiKeyContext }>();
    const raw = req.headers["x-api-key"];
    const rawKey = Array.isArray(raw) ? raw[0] : raw;
    if (!rawKey) throw new UnauthorizedException("Missing X-API-Key header");

    const keyHash = createHash("sha256").update(rawKey).digest("hex");
    const apiKey = await this.db.query.apiKeys.findFirst({
      where: and(eq(apiKeys.keyHash, keyHash), eq(apiKeys.isRevoked, false)),
    });
    if (!apiKey) throw new UnauthorizedException("Invalid or revoked API key");
    if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
      throw new UnauthorizedException("API key has expired");
    }

    const rl = await this.rateLimit.check("api-key-ingest", apiKey.id);
    if (!rl.allowed) {
      throw new HttpException(
        { error: "Rate limit exceeded", retryAfterSecs: rl.retryAfterSecs },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (apiKey.scopes && apiKey.scopes.length > 0) {
      const hasScope = REQUIRED_SCOPES.some((s) => apiKey.scopes.includes(s));
      if (!hasScope) throw new ForbiddenException("API key does not have leads:write scope");
    }

    void this.db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, apiKey.id)).catch(() => undefined);

    req.apiKey = { id: apiKey.id, orgId: apiKey.orgId, scopes: apiKey.scopes ?? [] };
    return true;
  }
}
