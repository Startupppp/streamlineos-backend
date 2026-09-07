import { Controller, Get, Query, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { GeneralLedgerService } from "./general-ledger.service";
import {
  glQuerySchema,
  glAccountsQuerySchema,
  type GlQuery,
  type GlAccountsQuery,
} from "./dto/general-ledger.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { generalLedgerResponseSchema, glAccountsWithActivityResponseSchema } from "./dto/gl-response.schemas";

@RequireModule("accounting")
@Controller("accounting/general-ledger")
@UseGuards(JwtAuthGuard)
export class GeneralLedgerController {
  constructor(private readonly gl: GeneralLedgerService) {}

  @Get()
  @ResponseSchema(generalLedgerResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:general-ledger:read")
  @Validate({ query: glQuerySchema })
  async getGeneralLedger(
    @Query() query: GlQuery,
    @CurrentUser() u: CurrentUserContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (query.format === "csv") {
      const csv = await this.gl.getGeneralLedgerCsv(u.orgId, query);
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="general-ledger-${query.from}-${query.to}.csv"`);
      res.send(csv);
      return;
    }
    return this.gl.getGeneralLedger(u.orgId, query);
  }

  @Get("accounts")
  @ResponseSchema(glAccountsWithActivityResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:general-ledger:read")
  @Validate({ query: glAccountsQuerySchema })
  getAccountsWithActivity(
    @Query() query: GlAccountsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.gl.getAccountsWithActivity(u.orgId, query);
  }
}
