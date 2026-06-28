import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { Public } from "../../common/auth/public.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { RateLimitService } from "../../common/ratelimit/rate-limit.service";
import { AuthService } from "./auth.service";
import { SessionService } from "./session.service";
import { DeviceService } from "./device.service";
import {
  registerSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  verifyEmailSchema,
  changePasswordSchema,
  resendVerificationSchema,
  magicLinkRequestSchema,
  magicLinkVerifySchema,
  type RegisterInput,
  type LoginInput,
  type ForgotPasswordInput,
  type ResetPasswordInput,
  type VerifyEmailInput,
  type ChangePasswordInput,
  type MagicLinkRequestInput,
  type MagicLinkVerifyInput,
} from "./dto/auth.schemas";

const loginHistoryQuerySchema = z.object({
  success: z
    .string()
    .optional()
    .transform((v) => (v === "true" ? true : v === "false" ? false : undefined)),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

type LoginHistoryQuery = z.infer<typeof loginHistoryQuerySchema>;

@Controller("auth")
@UseGuards(JwtAuthGuard)
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly sessionService: SessionService,
    private readonly deviceService: DeviceService,
    private readonly rateLimit: RateLimitService,
  ) {}

  private getIp(req: { ip?: string; headers: Record<string, string> }): string {
    return req.headers["x-forwarded-for"]?.split(",")?.[0]?.trim() ?? req.ip ?? "unknown";
  }

  private async enforceRateLimit(
    tier: string,
    identifier: string,
  ): Promise<void> {
    const result = await this.rateLimit.check(tier, identifier);
    if (!result.allowed) {
      throw new HttpException(
        { error_code: "RATE_LIMITED", retryAfter: result.retryAfterSecs },
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

  @Post("login")
  @Public()
  @HttpCode(200)
  async login(
    @Body(new ZodValidationPipe(loginSchema)) body: LoginInput,
    @Request() req: { ip?: string; headers: Record<string, string> },
  ) {
    await this.enforceRateLimit("auth:login", this.getIp(req));
    return this.authService.login(body, {
      ipAddress: this.getIp(req),
      userAgent: req.headers["user-agent"],
      fingerprint: body.fingerprint,
    });
  }

  @Post("logout")
  @HttpCode(200)
  logout(@CurrentUser() u: CurrentUserContext) {
    return this.authService.logout(u.sessionId ?? "", u.userId);
  }

  @Post("logout-all")
  @HttpCode(200)
  logoutAll(@CurrentUser() u: CurrentUserContext) {
    return this.authService.logoutAll(u.userId, u.sessionId);
  }

  @Post("forgot-password")
  @Public()
  @HttpCode(200)
  async forgotPassword(
    @Body(new ZodValidationPipe(forgotPasswordSchema)) body: ForgotPasswordInput,
    @Request() req: { ip?: string; headers: Record<string, string> },
  ) {
    await this.enforceRateLimit("auth:forgot-password", this.getIp(req));
    return this.authService.forgotPassword(body).then(() => ({ message: "If an account exists, a reset email has been sent" }));
  }

  @Post("reset-password")
  @Public()
  @HttpCode(200)
  resetPassword(@Body(new ZodValidationPipe(resetPasswordSchema)) body: ResetPasswordInput) {
    return this.authService.resetPassword(body).then(() => ({ message: "Password reset successfully" }));
  }

  @Post("verify-email")
  @Public()
  @HttpCode(200)
  async verifyEmail(
    @Body(new ZodValidationPipe(verifyEmailSchema)) body: VerifyEmailInput,
    @Request() req: { ip?: string; headers: Record<string, string> },
  ) {
    await this.enforceRateLimit("auth:verify-email", this.getIp(req));
    return this.authService.verifyEmail(body).then(() => ({ message: "Email verified successfully" }));
  }

  @Post("resend-verification")
  @Public()
  @HttpCode(200)
  async resendVerification(
    @Body(new ZodValidationPipe(resendVerificationSchema)) body: { email: string },
    @Request() req: { ip?: string; headers: Record<string, string> },
  ) {
    await this.enforceRateLimit("auth:resend-verification", this.getIp(req));
    return this.authService.resendVerification(body.email).then(() => ({ message: "If an account exists, a verification email has been sent" }));
  }

  @Post("change-password")
  @HttpCode(200)
  changePassword(
    @Body(new ZodValidationPipe(changePasswordSchema)) body: ChangePasswordInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.authService.changePassword(u.userId, body).then(() => ({ message: "Password changed successfully" }));
  }

  @Get("session")
  getSession(@CurrentUser() u: CurrentUserContext) {
    return { userId: u.userId, orgId: u.orgId, role: u.role, permissions: u.permissions };
  }

  @Get("sessions")
  listSessions(@CurrentUser() u: CurrentUserContext) {
    return this.sessionService.listActive(u.userId);
  }

  @Delete("sessions")
  revokeAllSessions(@CurrentUser() u: CurrentUserContext) {
    return this.authService.logoutAll(u.userId, u.sessionId).then(() => ({ message: "All other sessions revoked" }));
  }

  @Delete("sessions/:id")
  revokeSession(@Param("id") id: string, @CurrentUser() u: CurrentUserContext) {
    return this.authService.logout(id, u.userId).then(() => ({ message: "Session revoked" }));
  }

  @Get("devices")
  listDevices(@CurrentUser() u: CurrentUserContext) {
    return this.deviceService.list(u.userId);
  }

  @Post("devices/:id/trust")
  @HttpCode(200)
  trustDevice(@Param("id") id: string, @CurrentUser() u: CurrentUserContext) {
    return this.deviceService.trust(id, u.userId).then(() => ({ message: "Device trusted" }));
  }

  @Delete("devices/:id")
  removeDevice(@Param("id") id: string, @CurrentUser() u: CurrentUserContext) {
    return this.deviceService.remove(id, u.userId).then(() => ({ message: "Device removed" }));
  }

  @Get("login-history")
  loginHistory(
    @Query(new ZodValidationPipe(loginHistoryQuerySchema)) query: LoginHistoryQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.authService.getLoginHistory(u.userId, query);
  }

  @Get("audit/analytics")
  getAuditAnalytics() {
    return this.authService.getAuditAnalytics();
  }

  @Post("magic-link")
  @Public()
  @HttpCode(200)
  async requestMagicLink(
    @Body(new ZodValidationPipe(magicLinkRequestSchema)) body: MagicLinkRequestInput,
    @Request() req: { ip?: string; headers: Record<string, string> },
  ) {
    await this.enforceRateLimit("auth:magic-link", this.getIp(req));
    await this.authService.requestMagicLink(body);
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
    return this.authService.verifyMagicLink(body.token);
  }
}
