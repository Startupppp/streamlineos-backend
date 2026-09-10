import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { CoaService } from "./coa.service";
import { z } from "zod";
import { Validate } from "../../../common/validation/validate.decorator";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  coaTreeResponseSchema,
  coaTemplatesResponseSchema,
  coaApplyTemplateResponseSchema,
  coaAccountStatusResponseSchema,
  coaDeleteAccountResponseSchema,
} from "./dto/settings-response.schemas";
import { applyTemplateSchema, type ApplyTemplateInput } from "./dto/settings.schemas";

const accountIdParams = z.object({ accountId: z.coerce.number().int().positive() }).strict();

@RequireModule("accounting")
@Controller("accounting/coa")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class CoaController {
  constructor(private readonly coa: CoaService) {}

  @Get("tree")
  @ResponseSchema(coaTreeResponseSchema)
  @RequirePermission("accounting:accounts:read")
  getTree(@CurrentUser() u: CurrentUserContext) {
    return this.coa.getTree(u.orgId);
  }

  @Get("templates")
  @ResponseSchema(coaTemplatesResponseSchema)
  @RequirePermission("accounting:accounts:read")
  getTemplates() {
    return this.coa.getTemplates();
  }

  @Post("templates/apply")
  @ResponseSchema(coaApplyTemplateResponseSchema)
  @RequirePermission("accounting:accounts:manage")
  @HttpCode(200)
  @Validate({ body: applyTemplateSchema })
  applyTemplate(
    @Body() body: ApplyTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.coa.applyTemplate(u, body.templateKey);
  }

  @Post(":accountId/deactivate")
  @ResponseSchema(coaAccountStatusResponseSchema)
  @BodylessAction()
  @RequirePermission("accounting:accounts:manage")
  @HttpCode(200)
  @Validate({ params: accountIdParams })
  deactivateAccount(
    @Param("accountId", ParseIntPipe) accountId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.coa.deactivateAccount(u, accountId);
  }

  @Post(":accountId/activate")
  @ResponseSchema(coaAccountStatusResponseSchema)
  @BodylessAction()
  @RequirePermission("accounting:accounts:manage")
  @HttpCode(200)
  @Validate({ params: accountIdParams })
  activateAccount(
    @Param("accountId", ParseIntPipe) accountId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.coa.activateAccount(u, accountId);
  }

  @Delete(":accountId")
  @ResponseSchema(coaDeleteAccountResponseSchema)
  @RequirePermission("accounting:accounts:manage")
  @HttpCode(200)
  @Validate({ params: accountIdParams })
  deleteAccount(
    @Param("accountId", ParseIntPipe) accountId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.coa.deleteAccount(u, accountId);
  }
}
