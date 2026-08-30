import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { Public } from "../../../common/auth/public.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { Validate } from "../../../common/validation/validate.decorator";
import { SupportCsatService } from "./support-csat.service";
import { submitCsatSchema, type SubmitCsatInput } from "./dto/support.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { ModuleGuard } from "../../../common/rbac/module.guard";

const tokenParams = z.object({ token: z.string().min(1) }).strict();

@RequireModule("support")
@Controller("support")
export class SupportCsatController {
  constructor(private readonly csat: SupportCsatService) {}

  @Get("reports/csat")
  @UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
  @RequirePermission("support:reports:view")
  getCsatReport(@CurrentUser() u: CurrentUserContext) {
    return this.csat.getReport(u.orgId);
  }

  /** Public — the customer follows an emailed link with no session. */
  @Public()
  @Get("csat/:token")
  @Validate({ params: tokenParams })
  getCsatRequest(@Param("token") token: string) {
    return this.csat.getByToken(token);
  }

  @Public()
  @Post("csat/:token")
  @HttpCode(200)
  @Validate({ params: tokenParams })
  submitCsat(
    @Param("token") token: string,
    @Body(new ZodValidationPipe(submitCsatSchema)) body: SubmitCsatInput,
  ) {
    return this.csat.submit(token, body);
  }
}
