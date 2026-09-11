import { Body, Controller, Get, Header, HttpCode, HttpStatus, Post, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../../access/permission.guard";
import { RequirePermission } from "../../../access/require-permission.decorator";
import { CurrentUser } from "../../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { ModuleGuard } from "../../../../common/rbac/module.guard";
import { RequireModule } from "../../../../common/rbac/require-module.decorator";
import { RateLimitGuard } from "../../../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../../../common/ratelimit/use-rate-limit.decorator";
import { ZodValidationPipe } from "../../../../common/pipes/zod-validation.pipe";
import { InvReportBuilderService } from "./inv-report-builder.service";
import { INV_REPORT_CATALOG, describeInvReports } from "./inv-report-catalog";
import { INV_REPORT_IDS } from "./dto/inv-report-spec.schemas";
import {
  invReportAskSchema,
  invReportRunSchema,
  type InvReportAskInput,
  type InvReportRunInput,
} from "./dto/inv-report-spec.schemas";
import { ApiOkResponse } from "@nestjs/swagger";
import { ResponseSchema } from "../../../../common/openapi/zod-operation-contracts";
import {
  invReportAskResponseSchema,
  invReportCatalogResponseSchema,
} from "./dto/inv-report-builder-response.schemas";

/**
 * F5 — the natural-language report builder's routes.
 *
 * `ask` may spend credits, so it is a POST that happens because a human pressed
 * something; no page render reaches it. It is gated on `inventory:ai:read`
 * because asking is reading — and the report's *own* permission is then checked
 * inside the service, before the report runs. Two gates rather than one, because
 * "may use the AI surface" and "may read the valuation report" are different
 * questions and the first has never answered the second.
 *
 * `export` spends no credits at all: it takes a spec the caller already has, so
 * there is no model in the path. It carries `inventory:export` on the decorator
 * as the cheap early denial; the report's view key and, for the ledger,
 * `inventory:audit:export`, are asserted in the service against the spec the
 * caller actually sent — `@RequirePermission` takes one key, so the conjunction
 * is not expressible on the decorator and the decorator is not the boundary.
 */
@RequireModule("inventory")
@Controller("inventory/ai/reports")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class InvReportBuilderController {
  constructor(private readonly builder: InvReportBuilderService) {}

  /**
   * The catalogue, so a client can offer the six as buttons rather than making
   * everybody guess what the box understands. Static, identical for every
   * caller, and deterministic — no provider, no credits, safe on page load.
   */
  @Get("catalog")
  @ResponseSchema(invReportCatalogResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:ai:read")
  catalog() {
    return {
      reports: INV_REPORT_IDS.map((id) => {
        const definition = INV_REPORT_CATALOG[id];
        return {
          id,
          label: definition.label,
          description: definition.description,
          viewPermission: definition.viewPermission,
          exportPermission: definition.exportPermission,
          takesWarehouse: definition.takesWarehouse,
          columns: definition.columns.map((column) => ({
            key: column.path,
            label: column.label,
            numeric: column.numeric === true,
          })),
        };
      }),
      /** The same text the model is shown, so the two cannot disagree. */
      prompt: describeInvReports(),
    };
  }

  @Post("ask")
  @ResponseSchema(invReportAskResponseSchema)
  @UseGuards(PermissionGuard, RateLimitGuard)
  @UseRateLimit("ai:invoke")
  @RequirePermission("inventory:ai:read")
  @HttpCode(HttpStatus.OK)
  ask(
    @Body(new ZodValidationPipe(invReportAskSchema)) body: InvReportAskInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.builder.ask(u, body);
  }

  @Post("export")
  @ApiOkResponse({
    description: "CSV file download",
    content: { "text/csv": { schema: { type: "string" } } },
  })
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:export")
  @Header("Cache-Control", "no-store")
  async export(
    @Body(new ZodValidationPipe(invReportRunSchema)) body: InvReportRunInput,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ): Promise<void> {
    const file = await this.builder.export(u, body.spec);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
    res.setHeader("X-Row-Count", String(file.rowCount));
    res.send(file.csv);
  }
}
