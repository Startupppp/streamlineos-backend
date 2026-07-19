import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Request,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { Public } from "../../common/auth/public.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { RateLimitService } from "../../common/ratelimit/rate-limit.service";
import { AuthService } from "./auth.service";
import { AuthTokensService } from "./auth-tokens.service";
import {
  registerSchema,
  verifyEmailSchema,
  resendVerificationSchema,
  magicLinkRequestSchema,
  magicLinkVerifySchema,
  googleOAuthSchema,
  requestEmailOtpSchema,
  verifyEmailOtpSchema,
  type RegisterInput,
  type VerifyEmailInput,
  type MagicLinkRequestInput,
  type MagicLinkVerifyInput,
  type GoogleOAuthInput,
  type RequestEmailOtpInput,
  type VerifyEmailOtpInput,
} from "./dto/auth.schemas";

@Controller("auth")
@UseGuards(JwtAuthGuard)
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly authTokensService: AuthTokensService,
    private readonly rateLimit: RateLimitService,
  ) {}

  private getIp(req: { ip?: string; headers: Record<string, string> }): string {
    return req.headers["x-forwarded-for"]?.split(",")?.[0]?.trim() ?? req.ip ?? "unknown";
  }

  private resolveClientContext(req: { ip?: string; headers: Record<string, string> }): {
    userAgent: string;
    ipAddress: string;
  } {
    const rawUa = req.headers["x-client-user-agent"] ?? req.headers["user-agent"] ?? "";
    const userAgent = rawUa.slice(0, 500);
    const ipAddress =
      req.headers["x-client-ip"] ??
      req.headers["x-forwarded-for"]?.split(",")?.[0]?.trim() ??
      req.ip ??
      "unknown";
    return { userAgent, ipAddress };
  }

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
  async register(
    @Body(new ZodValidationPipe(registerSchema)) body: RegisterInput,
    @Request() req: { ip?: string; headers: Record<string, string> },
  ) {
    await this.enforceRateLimit("auth:register", this.getIp(req));
    return this.authService.register(body);
  }

  @Post("logout")
  @HttpCode(200)
  logout(@CurrentUser() u: CurrentUserContext) {
    return this.authService.logout(u.sessionId ?? "", u.userId);
  }

  @Post("verify-email")
  @Public()
  @HttpCode(200)
  async verifyEmail(
    @Body(new ZodValidationPipe(verifyEmailSchema)) body: VerifyEmailInput,
    @Request() req: { ip?: string; headers: Record<string, string> },
  ) {
    await this.enforceRateLimit("auth:verify-email", this.getIp(req));
    return this.authTokensService.verifyEmail(body);
  }

  @Post("resend-verification")
  @Public()
  @HttpCode(200)
  async resendVerification(
    @Body(new ZodValidationPipe(resendVerificationSchema)) body: { email: string },
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
  async getSessionData(
    @Param("userId") userId: string,
    @Request() req: { headers: Record<string, string> },
  ) {
    const secret = process.env.INTERNAL_API_SECRET;
    if (!secret || req.headers["x-internal-secret"] !== secret) {
      throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    }
    return this.authService.getSessionData(userId);
  }

  @Post("magic-link")
  @Public()
  @HttpCode(200)
  async requestMagicLink(
    @Body(new ZodValidationPipe(magicLinkRequestSchema)) body: MagicLinkRequestInput,
    @Request() req: { ip?: string; headers: Record<string, string> },
  ) {
    await this.enforceRateLimit("auth:magic-link", this.getIp(req));
    await this.authTokensService.requestMagicLink(body);
    return { message: "If an account exists, a sign-in link has been sent" };
  }

  @Post("magic-link/verify")
  @Public()
  @HttpCode(200)
  async verifyMagicLink(
    @Body(new ZodValidationPipe(magicLinkVerifySchema)) body: MagicLinkVerifyInput,
    @Request() req: { ip?: string; headers: Record<string, string> },
  ) {
    await this.enforceRateLimit("auth:magic-link-verify", this.getIp(req));
    return this.authTokensService.verifyMagicLink(body.token, this.resolveClientContext(req));
  }

  @Post("google")
  @Public()
  @HttpCode(200)
  async googleOAuth(
    @Body(new ZodValidationPipe(googleOAuthSchema)) body: GoogleOAuthInput,
    @Request() req: { ip?: string; headers: Record<string, string> },
  ) {
    const secret = process.env.INTERNAL_API_SECRET;
    if (!secret || req.headers["x-internal-secret"] !== secret) {
      throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    }
    return this.authTokensService.googleOAuth(body, this.resolveClientContext(req));
  }

  @Post("email-otp")
  @Public()
  @HttpCode(200)
  async requestEmailOtp(
    @Body(new ZodValidationPipe(requestEmailOtpSchema)) body: RequestEmailOtpInput,
    @Request() req: { ip?: string; headers: Record<string, string> },
  ) {
    await this.enforceRateLimit("auth:email-otp", this.getIp(req));
    await this.authTokensService.requestEmailOtp(body.email);
    return { message: "If an account exists, a one-time code has been sent" };
  }

  @Post("email-otp/verify")
  @Public()
  @HttpCode(200)
  async verifyEmailOtp(
    @Body(new ZodValidationPipe(verifyEmailOtpSchema)) body: VerifyEmailOtpInput,
    @Request() req: { ip?: string; headers: Record<string, string> },
  ) {
    await this.enforceRateLimit("auth:email-otp-verify", this.getIp(req));
    return this.authTokensService.verifyEmailOtp(body.email, body.code);
  }
}
