import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import { QuotesService, isSendNotDraft } from "./quotes.service";
import {
  createSchema,
  exportSchema,
  listSchema,
  updateSchema,
  approveRejectSchema,
  markSignedSchema,
  type CreateInput,
  type ExportInput,
  type ListInput,
  type UpdateInput,
  type ApproveRejectInput,
  type MarkSignedInput,
} from "./dto/quote.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { z } from "zod";
import { Validate } from "../../common/validation/validate.decorator";
import { BodylessAction } from "../../common/openapi/zod-operation-contracts";

const quoteIdParams = z.object({ quoteId: z.coerce.number().int().positive() }).strict();

@RequireModule("crm")
@Controller("quotes")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class QuotesController {
  constructor(private readonly quotes: QuotesService) {}

  @Get()
  @RequirePermission("crm:quotes:read")
  @Validate({ query: listSchema })
  list(
    @Query() filters: ListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.quotes.list(u.orgId, filters);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("crm:quotes:create")
  @Idempotent("crm.quote.create")
  @Validate({ body: createSchema })
  create(
    @Body() body: CreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.quotes.create(u.orgId, u.userId, body);
  }

  @Get("export")
  @RequirePermission("crm:quotes:read")
  @Validate({ query: exportSchema })
  async exportCsv(
    @Query() query: ExportInput,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ) {
    const csv = await this.quotes.buildExportCsv(u.orgId, u.userId, query);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="quotes-${new Date().toISOString().split("T")[0]}.csv"`,
    );
    res.send(csv);
  }

  @Get(":quoteId")
  @RequirePermission("crm:quotes:read")
  @Validate({ params: quoteIdParams })
  async get(
    @Param("quoteId", ParseIntPipe) quoteId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const quote = await this.quotes.getQuote(u.orgId, quoteId);
    if (!quote) throw new NotFoundException("Quote not found");
    return quote;
  }

  @Patch(":quoteId")
  @RequirePermission("crm:quotes:update")
  @Validate({ params: quoteIdParams, body: updateSchema })
  async update(
    @Param("quoteId", ParseIntPipe) quoteId: number,
    @Body() body: UpdateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const updated = await this.quotes.update(u.orgId, u.userId, quoteId, body);
    if (!updated) throw new NotFoundException("Quote not found");
    return updated;
  }

  @Delete(":quoteId")
  @RequirePermission("crm:quotes:delete")
  @Validate({ params: quoteIdParams })
  async remove(
    @Param("quoteId", ParseIntPipe) quoteId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.quotes.remove(u.orgId, u.userId, quoteId);
    if (!result) throw new NotFoundException("Quote not found");
    return result;
  }

  @Post(":quoteId/send")
  @RequirePermission("crm:quotes:update")
  @Idempotent("crm.quote.send")
  @Validate({ params: quoteIdParams })
  @BodylessAction()
  async send(
    @Param("quoteId", ParseIntPipe) quoteId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.quotes.send(u.orgId, u.userId, quoteId);
    if (!result) throw new NotFoundException("Quote not found");
    if (isSendNotDraft(result)) throw new BadRequestException("Only draft quotes can be sent");
    return result;
  }

  @Post(":quoteId/approve")
  @Idempotent("quotes.quote.approve")
  @RequirePermission("crm:quotes:approve")
  @Validate({ params: quoteIdParams })
  @BodylessAction()
  async approve(
    @Param("quoteId", ParseIntPipe) quoteId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.quotes.approve(u.orgId, u.userId, quoteId);
  }

  @Post(":quoteId/reject")
  @Idempotent("quotes.quote.reject")
  @RequirePermission("crm:quotes:approve")
  @Validate({ params: quoteIdParams, body: approveRejectSchema })
  async reject(
    @Param("quoteId", ParseIntPipe) quoteId: number,
    @Body() body: ApproveRejectInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.quotes.reject(u.orgId, u.userId, quoteId, body.reason);
  }

  @Post(":quoteId/convert-to-invoice")
  @RequirePermission("crm:quotes:create")
  @Idempotent("crm.quote.convertToInvoice")
  @Validate({ params: quoteIdParams })
  @BodylessAction()
  async convertToInvoice(
    @Param("quoteId", ParseIntPipe) quoteId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.quotes.convertToInvoice(u.orgId, u.userId, quoteId);
  }

  @Post(":quoteId/mark-signed")
  @RequirePermission("crm:quotes:update")
  @Validate({ params: quoteIdParams, body: markSignedSchema })
  async markSigned(
    @Param("quoteId", ParseIntPipe) quoteId: number,
    @Body() body: MarkSignedInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.quotes.markSigned(u.orgId, u.userId, quoteId, body.documentRef);
  }
}
