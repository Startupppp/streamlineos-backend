import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { CoaService } from "./coa.service";
import { z } from "zod";

const applyTemplateSchema = z.object({ templateKey: z.string() });
type ApplyTemplateInput = z.infer<typeof applyTemplateSchema>;

@RequireModule("accounting")
@Controller("accounting/coa")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class CoaController {
  constructor(private readonly coa: CoaService) {}

  @Get("tree")
  @RequirePermission("accounting:accounts:read")
  getTree(@CurrentUser() u: CurrentUserContext) {
    return this.coa.getTree(u.orgId);
  }

  @Get("templates")
  @RequirePermission("accounting:accounts:read")
  getTemplates() {
    return this.coa.getTemplates();
  }

  @Post("templates/apply")
  @RequirePermission("accounting:accounts:manage")
  @HttpCode(200)
  applyTemplate(
    @Body(new ZodValidationPipe(applyTemplateSchema)) body: ApplyTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.coa.applyTemplate(u, body.templateKey);
  }

  @Post(":accountId/deactivate")
  @RequirePermission("accounting:accounts:manage")
  @HttpCode(200)
  deactivateAccount(
    @Param("accountId", ParseIntPipe) accountId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.coa.deactivateAccount(u, accountId);
  }

  @Post(":accountId/activate")
  @RequirePermission("accounting:accounts:manage")
  @HttpCode(200)
  activateAccount(
    @Param("accountId", ParseIntPipe) accountId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.coa.activateAccount(u, accountId);
  }

  @Delete(":accountId")
  @RequirePermission("accounting:accounts:manage")
  @HttpCode(200)
  deleteAccount(
    @Param("accountId", ParseIntPipe) accountId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.coa.deleteAccount(u, accountId);
  }
}
