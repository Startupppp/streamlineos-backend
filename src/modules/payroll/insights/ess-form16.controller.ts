import { Controller, Get, Param, StreamableFile, UseGuards } from "@nestjs/common";
import { ApiOkResponse } from "@nestjs/swagger";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../common/auth/principal";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { Form16DocumentsService } from "../filings/form16-documents.service";
import { essForm16ListResponseSchema, form16FyParamsSchema } from "../filings/dto/form16-documents.schemas";

@Controller("payroll/me/form16")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class EssForm16Controller {
  constructor(private readonly form16: Form16DocumentsService) {}

  @Get()
  @RequirePermission("self:payslips")
  @ResponseSchema(essForm16ListResponseSchema)
  list(@CurrentUser() u: CurrentUserContext) {
    return this.form16.listOwn(u.orgId, actingMembershipId(u.principal));
  }

  @Get(":financialYear/download")
  @RequirePermission("self:payslips")
  @Validate({ params: form16FyParamsSchema })
  @ApiOkResponse({ description: "Own released Form 16 PDF", content: { "application/pdf": { schema: { type: "string", format: "binary" } } } })
  download(@CurrentUser() u: CurrentUserContext, @Param("financialYear") financialYear: string): Promise<StreamableFile> {
    return this.form16.downloadOwn(u.orgId, actingMembershipId(u.principal), financialYear);
  }
}
