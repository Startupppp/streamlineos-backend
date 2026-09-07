import { Controller, Get, Param, ParseIntPipe, Query, Res, UseGuards } from "@nestjs/common";
import { ApiOkResponse } from "@nestjs/swagger";
import type { Response } from "express";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { StatementsService } from "./statements.service";
import { customerStatementSchema, type CustomerStatementQuery } from "./dto/finance-ar.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const clientIdParams = z.object({ clientId: z.coerce.number().int().positive() }).strict();

@RequireModule("accounting")
@Controller("accounting/customer-statements")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class StatementsController {
  constructor(private readonly svc: StatementsService) {}

  @Get(":clientId")
  @ApiOkResponse({
    description: "Customer statement (JSON or CSV)",
    content: {
      "application/json": {
        schema: {
          type: "object",
          properties: {
            clientId: { type: "number" },
            clientName: { type: "string" },
            from: { type: "string", nullable: true },
            to: { type: "string", nullable: true },
            openingBalance: { type: "number" },
            closingBalance: { type: "number" },
            lines: { type: "array", items: { type: "object" } },
          },
        },
      },
      "text/csv": { schema: { type: "string" } },
    },
  })
  @RequirePermission("accounting:receivables:read")
  @Validate({ params: clientIdParams, query: customerStatementSchema })
  async statement(
    @Param("clientId", ParseIntPipe) clientId: number,
    @Query() query: CustomerStatementQuery,
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
