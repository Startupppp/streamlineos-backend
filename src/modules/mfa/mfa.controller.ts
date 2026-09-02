import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  UseGuards,
} from "@nestjs/common";
import { RateLimitService } from "../../common/ratelimit/rate-limit.service";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { Universal } from "../../common/auth/universal.decorator";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { AllowWithoutMfa } from "../../common/auth/allow-without-mfa.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { Validate } from "../../common/validation/validate.decorator";
import { BodylessAction } from "../../common/openapi/zod-operation-contracts";
import { MfaService } from "./mfa.service";
import {
  verifyMfaSchema,
  disableMfaSchema,
  resetMfaSchema,
  type VerifyMfaInput,
  type DisableMfaInput,
  type ResetMfaInput,
} from "./dto/mfa.schemas";

@Controller("auth/mfa")
@UseGuards(JwtAuthGuard)
@AllowWithoutMfa()
export class MfaController {
  constructor(
    private readonly mfa: MfaService,
    private readonly rateLimit: RateLimitService,
  ) {}

  private async enforceAttemptLimit(tier: string, userId: string): Promise<void> {
    const result = await this.rateLimit.check(tier, userId);
    if (!result.allowed) {
      throw new HttpException(
        {
          code: "AUTH_RATE_LIMITED",
          message: "Too many attempts. Try again later.",
          details: { retryAfterSeconds: result.retryAfterSecs },
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  @Post("setup")
  @BodylessAction()
  @Universal()
  @HttpCode(200)
  setup(@CurrentUser() u: CurrentUserContext) {
    return this.mfa.setup(u.userId);
  }

  @Post("verify")
  @Universal()
  @HttpCode(200)
  @Validate({ body: verifyMfaSchema })
  async verify(
    @Body() body: VerifyMfaInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.enforceAttemptLimit("auth:mfa-verify", u.userId);
    return this.mfa.verify(u.userId, body);
  }

  @Post("disable")
  @Universal()
  @HttpCode(200)
  @Validate({ body: disableMfaSchema })
  async disable(
    @Body() body: DisableMfaInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.enforceAttemptLimit("auth:mfa-disable", u.userId);
    return this.mfa.disable(u.userId, u.orgId, body);
  }

  @Get("status")
  @Universal()
  status(@CurrentUser() u: CurrentUserContext) {
    return this.mfa.status(u.userId);
  }

  @Post("reset")
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission("settings:mfa")
  @Validate({ body: resetMfaSchema })
  reset(@Body() body: ResetMfaInput, @CurrentUser() u: CurrentUserContext) {
    return this.mfa.reset(body.userId, u.orgId);
  }
}
