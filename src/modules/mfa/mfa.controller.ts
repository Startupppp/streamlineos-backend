import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { Universal } from "../../common/auth/universal.decorator";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { AllowWithoutMfa } from "../../common/auth/allow-without-mfa.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { Validate } from "../../common/validation/validate.decorator";
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
  constructor(private readonly mfa: MfaService) {}

  @Post("setup")
  @Universal()
  @HttpCode(200)
  setup(@CurrentUser() u: CurrentUserContext) {
    return this.mfa.setup(u.userId);
  }

  @Post("verify")
  @Universal()
  @HttpCode(200)
  @Validate({ body: verifyMfaSchema })
  verify(
    @Body() body: VerifyMfaInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.mfa.verify(u.userId, body);
  }

  @Post("disable")
  @Universal()
  @HttpCode(200)
  @Validate({ body: disableMfaSchema })
  disable(
    @Body() body: DisableMfaInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
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
  reset(@Body() body: ResetMfaInput) {
    return this.mfa.reset(body.userId);
  }
}
