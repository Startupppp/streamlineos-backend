import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import { createHash } from "crypto";
import { and, eq } from "drizzle-orm";
import { apiKeys } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { RateLimitService } from "../ratelimit/rate-limit.service";
import type { ApiKeyContext } from "./api-key.decorator";
import { EntitlementsService } from "../../modules/access/entitlements.service";

const CRM_LEAD_INGEST_SCOPE = "leads:write";

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly rateLimit: RateLimitService,
    private readonly entitlements: EntitlementsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { apiKey?: ApiKeyContext }>();
    const raw = req.headers["x-api-key"];
    const rawKey = Array.isArray(raw) ? raw[0] : raw;
    if (!rawKey) throw new UnauthorizedException("Missing X-API-Key header");

    const keyHash = createHash("sha256").update(rawKey).digest("hex");
    const apiKey = await this.db.query.apiKeys.findFirst({
      where: and(eq(apiKeys.keyHash, keyHash), eq(apiKeys.isRevoked, false)),
    });
    if (!apiKey) throw new UnauthorizedException("Invalid or revoked API key");
    if (!apiKey.expiresAt || apiKey.expiresAt < new Date())
      throw new UnauthorizedException(
        "API key is expired or has no expiration",
      );

    if (!(await this.entitlements.isModuleEnabled(apiKey.orgId, "crm")))
      throw new ForbiddenException("CRM module is not enabled");

    const rl = await this.rateLimit.check("api-key-ingest", apiKey.id);
    if (!rl.allowed)
      throw new HttpException(
        { error: "Rate limit exceeded", retryAfterSecs: rl.retryAfterSecs },
        HttpStatus.TOO_MANY_REQUESTS,
      );

    const hasScope = apiKey.scopes.includes(CRM_LEAD_INGEST_SCOPE);
    if (!hasScope)
      throw new ForbiddenException("API key does not have leads:write scope");

    void this.db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, apiKey.id))
      .catch(() => undefined);

    req.apiKey = {
      id: apiKey.id,
      orgId: apiKey.orgId,
      scopes: apiKey.scopes ?? [],
    };
    return true;
  }
}
