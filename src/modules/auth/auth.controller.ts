import {
  Body,
  Header,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Optional,
  Param,
  Post,
  Request,
  UseGuards,
} from "@nestjs/common";
import { jwtVerify } from "jose";
import type { Redis } from "@upstash/redis";
import { REDIS } from "../../common/cache/cache.service";
import { SESSION_PROOF_ISSUER, SESSION_PROOF_AUDIENCE } from "../../common/auth/backend-claims";
import { NO_COMPRESSION_HEADER } from "../../common/http/compression.config";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { JwtKeyringService } from "../../common/auth/jwt-keyring.service";
import { MembershipStateService } from "../../common/auth/membership-state.service";
import { Universal } from "../../common/auth/universal.decorator";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { Public } from "../../common/auth/public.decorator";
import { AllowWithoutMfa } from "../../common/auth/allow-without-mfa.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { RateLimitService } from "../../common/ratelimit/rate-limit.service";
import { AuthService } from "./auth.service";
import { AuthTokensService } from "./auth-tokens.service";
import { internalSecretMatches } from "./internal-secret";
import {
  registerSchema,
  verifyEmailSchema,
  resendVerificationSchema,
  magicLinkRequestSchema,
  magicLinkVerifySchema,
  googleOAuthSchema,
  requestEmailOtpSchema,
  verifyEmailOtpSchema,
  sessionExchangeSchema,
  type RegisterInput,
  type VerifyEmailInput,
  type MagicLinkRequestInput,
  type MagicLinkVerifyInput,
  type GoogleOAuthInput,
  type RequestEmailOtpInput,
  type VerifyEmailOtpInput,
  type SessionExchangeInput,
} from "./dto/auth.schemas";
import { enrichUserAgent } from "../../common/http/parse-user-agent";
import { Validate } from "../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction } from "../../common/openapi/zod-operation-contracts";
import { resolveClientIpOr } from "../../common/http/client-ip";

const userIdParams = z.object({ userId: z.string().min(1) }).strict();

@Controller("auth")
@UseGuards(JwtAuthGuard)
export class AuthController {
  private readonly nonceCache = new Map<string, number>();

  constructor(
    private readonly authService: AuthService,
    private readonly authTokensService: AuthTokensService,
    private readonly rateLimit: RateLimitService,
    private readonly keyring: JwtKeyringService,
    private readonly membershipState: MembershipStateService,
    @Optional() @Inject(REDIS) private readonly redis: Redis | null = null,
  ) {}

  private async isNonceFirstUse(nonce: string, ttlSecs: number): Promise<boolean> {
    if (this.redis) {
      const result = await this.redis.set(`exchange-nonce:${nonce}`, 1, { nx: true, ex: ttlSecs });
      return result !== null;
    }
    const now = Date.now();
    for (const [k, exp] of this.nonceCache)
      if (exp <= now) this.nonceCache.delete(k);
    if (this.nonceCache.has(nonce)) return false;
    this.nonceCache.set(nonce, now + ttlSecs * 1000);
    return true;
  }

  private getIp(req: { ip?: string; headers: Record<string, string> }): string {
    return resolveClientIpOr(req, "unknown");
  }

  /**
   * `x-client-ip` is the web tier telling us the browser's address, because the auth bridge
   * is a server-side fetch and no proxy appends a forwarded-for header to it.
   *
   * It is only believed AFTER `internalSecretMatches` has passed. It used to be believed on
   * every route that called this, including `POST /auth/magic-link/verify`, which is
   * `@Public()` and carries no secret — so any caller could write any address they liked into
   * the session record the user later reads as "where you are signed in". `trusted` is not
   * defaulted: each call site has to say which it is.
   */
  private resolveClientContext(
    req: { ip?: string; headers: Record<string, string> },
    trusted: "internal-secret-verified" | "untrusted",
  ): {
    userAgent: string;
    ipAddress: string;
  } {
    const rawUa = req.headers["x-client-user-agent"] ?? req.headers["user-agent"] ?? "";
    const clientApp = req.headers["x-client-app"] ?? req.headers["x-streamlineos-client"] ?? null;
    const userAgent = enrichUserAgent(rawUa, { clientApp });
    const declared =
      trusted === "internal-secret-verified" ? req.headers["x-client-ip"]?.trim() : undefined;
    const ipAddress = declared || resolveClientIpOr(req, "unknown");
    return { userAgent, ipAddress };
  }

  /**
   * The three INTERNAL_API_SECRET routes are limited on their SUBJECT (the user
   * the call is about, or the signing-in email) and only AFTER the secret check
   * passes. Their caller is the web tier, so every request arrives from one
   * server IP and a per-IP tier would be a single global bucket that throttles
   * the product; and the subject on two of them is attacker-supplied, so
   * limiting before the secret check would let an unauthenticated request
   * exhaust a named user's budget and lock them out of session refresh.
   */
  private async enforceRateLimit(
    tier: string,
    identifier: string,
  ): Promise<void> {
    const result = await this.rateLimit.check(tier, identifier);
    if (!result.allowed) {
      throw new HttpException(
        { code: "AUTH_RATE_LIMITED", message: "Too many attempts. Try again later.", details: { retryAfterSeconds: result.retryAfterSecs } },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  @Post("register")
  @Public()
  @HttpCode(201)
  @Validate({ body: registerSchema })
  async register(
    @Body() body: RegisterInput,
    @Request() req: { ip?: string; headers: Record<string, string> },
  ) {
    await this.enforceRateLimit("auth:register", this.getIp(req));
    return this.authService.register(body);
  }

  @Post("logout")
  @BodylessAction()
  @Universal()
  @HttpCode(200)
  @AllowWithoutMfa()
  logout(@CurrentUser() u: CurrentUserContext) {
    return this.authService.logout(u.sessionId ?? "", u.userId);
  }

  @Post("verify-email")
  @Public()
  @HttpCode(200)
  @Validate({ body: verifyEmailSchema })
  async verifyEmail(
    @Body() body: VerifyEmailInput,
    @Request() req: { ip?: string; headers: Record<string, string> },
  ) {
    await this.enforceRateLimit("auth:verify-email", this.getIp(req));
    return this.authTokensService.verifyEmail(body);
  }

  @Post("resend-verification")
  @Public()
  @HttpCode(200)
  @Validate({ body: resendVerificationSchema })
  async resendVerification(
    @Body() body: z.infer<typeof resendVerificationSchema>,
    @Request() req: { ip?: string; headers: Record<string, string> },
  ) {
    await this.enforceRateLimit("auth:resend-verification", this.getIp(req));
    return this.authTokensService.resendVerification(body.email).then(() => ({ message: "If an account exists, a verification email has been sent" }));
  }

  @Get("audit/analytics")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:manage")
  getAuditAnalytics() {
    return this.authTokensService.getAuditAnalytics();
  }

  @Public()
  @Get("session-data/:userId")
  @HttpCode(200)
  @Validate({ params: userIdParams })
  async getSessionData(
    @Param("userId") userId: string,
    @Request() req: { headers: Record<string, string> },
  ) {
    if (!internalSecretMatches(process.env.INTERNAL_API_SECRET, req.headers["x-internal-secret"])) {
      throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    }
    await this.enforceRateLimit("auth:session-data", userId);
    return this.authService.getSessionData(userId);
  }

  @Post("magic-link")
  @Public()
  @HttpCode(200)
  @Validate({ body: magicLinkRequestSchema })
  async requestMagicLink(
    @Body() body: MagicLinkRequestInput,
    @Request() req: { ip?: string; headers: Record<string, string> },
  ) {
    await this.enforceRateLimit("auth:magic-link", this.getIp(req));
    await this.authTokensService.requestMagicLink(body);
    return { message: "We've emailed you a sign-in link. Check your inbox." };
  }

  @Post("magic-link/verify")
  @Public()
  @HttpCode(200)
  @Validate({ body: magicLinkVerifySchema })
  async verifyMagicLink(
    @Body() body: MagicLinkVerifyInput,
    @Request() req: { ip?: string; headers: Record<string, string> },
  ) {
    await this.enforceRateLimit("auth:magic-link-verify", this.getIp(req));
    return this.authTokensService.verifyMagicLink(body.token, this.resolveClientContext(req, "untrusted"));
  }

  @Post("google")
  @Public()
  @HttpCode(200)
  @Validate({ body: googleOAuthSchema })
  async googleOAuth(
    @Body() body: GoogleOAuthInput,
    @Request() req: { ip?: string; headers: Record<string, string> },
  ) {
    if (!internalSecretMatches(process.env.INTERNAL_API_SECRET, req.headers["x-internal-secret"])) {
      throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    }
    await this.enforceRateLimit("auth:google", body.email.toLowerCase());
    return this.authTokensService.googleOAuth(body, this.resolveClientContext(req, "internal-secret-verified"));
  }

  @Post("email-otp")
  @Public()
  @HttpCode(200)
  @Validate({ body: requestEmailOtpSchema })
  async requestEmailOtp(
    @Body() body: RequestEmailOtpInput,
    @Request() req: { ip?: string; headers: Record<string, string> },
  ) {
    await this.enforceRateLimit("auth:email-otp", this.getIp(req));
    await this.authTokensService.requestEmailOtp(body.email);
    return { message: "We've emailed you a 6-digit sign-in code." };
  }

  @Post("email-otp/verify")
  @Public()
  @HttpCode(200)
  @Validate({ body: verifyEmailOtpSchema })
  async verifyEmailOtp(
    @Body() body: VerifyEmailOtpInput,
    @Request() req: { ip?: string; headers: Record<string, string> },
  ) {
    await this.enforceRateLimit("auth:email-otp-verify", this.getIp(req));
    return this.authTokensService.verifyEmailOtp(body.email, body.code);
  }

  @Post("session-exchange")
  @Public()
  @HttpCode(200)
  // PRD-C089 (BREACH) — this body is a bearer token, `app.enableCors({ credentials: true })`
  // is live, and a compressed length is a cross-origin size oracle. `shouldCompress` checks
  // this opt-out first, so no content type can overrule it.
  @Header(NO_COMPRESSION_HEADER, "1")
  @Validate({ body: sessionExchangeSchema })
  async sessionExchange(
    @Body() body: SessionExchangeInput,
    @Request() req: { headers: Record<string, string> },
  ): Promise<{ token: string }> {
    if (!internalSecretMatches(process.env.INTERNAL_API_SECRET, req.headers["x-internal-secret"])) {
      throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    }

    // Session proof required — identity comes from the verified proof, never from the body
    const proofJwt = req.headers["x-session-proof"];
    if (!proofJwt || typeof proofJwt !== "string") {
      throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    }

    const nextAuthSecret = process.env.NEXTAUTH_SECRET;
    if (!nextAuthSecret) {
      throw new HttpException("Service Unavailable", HttpStatus.SERVICE_UNAVAILABLE);
    }

    let userId: string;
    let sessionId: string;
    let nonce: string;
    try {
      const { payload } = await jwtVerify(
        proofJwt,
        new TextEncoder().encode(nextAuthSecret),
        {
          algorithms: ["HS256"],
          issuer: SESSION_PROOF_ISSUER,
          audience: SESSION_PROOF_AUDIENCE,
          clockTolerance: 5,
        },
      );
      const sub = payload.sub;
      const sid = payload["sessionId"];
      const jti = payload.jti;
      if (!sub || typeof sid !== "string" || !sid || !jti) {
        throw new Error("Missing required claims");
      }
      userId = sub;
      sessionId = sid;
      nonce = jti;
    } catch {
      throw new HttpException("Unauthorized", HttpStatus.UNAUTHORIZED);
    }

    await this.enforceRateLimit("auth:session-exchange", userId);

    const nonceAccepted = await this.isNonceFirstUse(nonce, 90);
    if (!nonceAccepted) {
      throw new HttpException("Unauthorized", HttpStatus.UNAUTHORIZED);
    }

    if (this.redis) {
      const tombstone = await this.redis.get<boolean>(`revoked:session:${sessionId}`);
      if (tombstone === true) {
        throw new HttpException("Unauthorized", HttpStatus.UNAUTHORIZED);
      }
    }

    const accountActive = await this.membershipState.isAccountActive(userId);
    if (!accountActive) {
      throw new HttpException("Unauthorized", HttpStatus.UNAUTHORIZED);
    }

    const orgId = body.orgId ?? null;
    if (orgId) {
      const state = await this.membershipState.resolve(userId, orgId);
      if (!state.active || state.membershipId === null) {
        throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
      }
    }

    if (!this.keyring.isReady()) {
      throw new HttpException("Service Unavailable", HttpStatus.SERVICE_UNAVAILABLE);
    }

    const token = await this.keyring.signToken({ sub: userId, orgId, sessionId });
    return { token };
  }

  @Get(".well-known/jwks.json")
  @Public()
  @HttpCode(200)
  getJwks() {
    return this.keyring.getJwks();
  }
}
