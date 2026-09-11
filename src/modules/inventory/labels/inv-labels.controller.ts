import { Controller, Get, Param, ParseIntPipe, Query, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { InvLabelsService } from "./inv-labels.service";
import {
  variantLabelQuerySchema,
  type VariantLabelQueryInput,
} from "./dto/inv-labels.schemas";
import { ApiOkResponse } from "@nestjs/swagger";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { variantLabelResponseSchema } from "./dto/inv-labels-response.schemas";

/**
 * G4 — labels and printable warehouse documents.
 *
 * One key, `inventory:labels:print`, already in the catalogue and already on the
 * supervisor and operator templates. It is the right grain: putting the
 * organisation's name and a vendor's prices on a piece of paper that leaves the
 * building is a distinct act from reading either on screen, and the people who do
 * it are not the people who raise purchase orders.
 *
 * Every route is a GET that writes nothing, so none of them takes an idempotency
 * key — a document is regenerated on every request from live data rather than
 * stored, which is why reprinting a receipt after it posts shows it as POSTED.
 *
 * The two PDF routes write to the response directly, the way the HR profile
 * export does. They are downloads, not envelopes, and a client that has just
 * asked for `application/pdf` should not receive `{ success: true, data: … }`
 * wrapped around a binary. The web client fetches them with its bearer token and
 * turns the blob into an object URL — a plain `<a href>` would carry no
 * Authorization header and 401.
 */
@RequireModule("inventory")
@Controller("inventory/labels")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class InvLabelsController {
  constructor(private readonly labels: InvLabelsService) {}

  /**
   * The label payload for one SKU, optionally for one lot of it. JSON, because
   * the symbology and the label stock are decisions made at the printer.
   */
  @Get("variants/:productVariantId")
  @ResponseSchema(variantLabelResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:labels:print")
  variantLabel(
    @Param("productVariantId", ParseIntPipe) productVariantId: number,
    @Query(new ZodValidationPipe(variantLabelQuerySchema)) query: VariantLabelQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.labels.variantLabel(u.orgId, productVariantId, query.lotId);
  }

  @Get("goods-receipts/:grnId/pdf")
  @ApiOkResponse({
    description: "Goods received note, as a PDF download",
    content: { "application/pdf": { schema: { type: "string", format: "binary" } } },
  })
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:labels:print")
  async grnNote(
    @Param("grnId", ParseIntPipe) grnId: number,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ): Promise<void> {
    const pdf = await this.labels.grnNote(u.orgId, grnId, u.userId);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="grn-${grnId}.pdf"`);
    res.send(pdf);
  }

  @Get("pick-lists/:pickListId/pdf")
  @ApiOkResponse({
    description: "Pick list, as a PDF download",
    content: { "application/pdf": { schema: { type: "string", format: "binary" } } },
  })
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:labels:print")
  async pickList(
    @Param("pickListId", ParseIntPipe) pickListId: number,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ): Promise<void> {
    const pdf = await this.labels.pickList(u.orgId, pickListId, u.userId);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="pick-list-${pickListId}.pdf"`);
    res.send(pdf);
  }
}
