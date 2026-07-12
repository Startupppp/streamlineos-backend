import { Controller, Get, Param, ParseIntPipe, Query, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { StatementsService } from "./statements.service";
import { customerStatementSchema, type CustomerStatementQuery } from "./dto/finance-ar.schemas";

@RequireModule("accounting")
@Controller("accounting/customer-statements")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class StatementsController {
  constructor(private readonly svc: StatementsService) {}

  @Get(":clientId")
  @RequirePermission("accounting:receivables:read")
  async statement(
    @Param("clientId", ParseIntPipe) clientId: number,
    @Query(new ZodValidationPipe(customerStatementSchema)) query: CustomerStatementQuery,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ) {
    const result = await this.svc.customerStatement(u.orgId, clientId, query);
    if ("format" in result && result.format === "csv") {
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="${result.filename}"`);
      res.send(result.content);
      return;
    }
    res.json(result);
  }
}
