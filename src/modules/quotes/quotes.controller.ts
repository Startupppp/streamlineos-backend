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
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { QuotesService, isSendNotDraft } from "./quotes.service";
import {
  createSchema,
  exportSchema,
  listSchema,
  updateSchema,
  type CreateInput,
  type ExportInput,
  type ListInput,
  type UpdateInput,
} from "./dto/quote.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";

@RequireModule("crm")
@Controller("quotes")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class QuotesController {
  constructor(private readonly quotes: QuotesService) {}

  @Get()
  @RequirePermission("crm:quotes:read")
  list(
    @Query(new ZodValidationPipe(listSchema)) filters: ListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.quotes.list(u.orgId, filters);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("crm:quotes:create")
  create(
    @Body(new ZodValidationPipe(createSchema)) body: CreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.quotes.create(u.orgId, u.userId, body);
  }

  @Get("export")
  @RequirePermission("crm:quotes:read")
  async exportCsv(
    @Query(new ZodValidationPipe(exportSchema)) query: ExportInput,
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
  async update(
    @Param("quoteId", ParseIntPipe) quoteId: number,
    @Body(new ZodValidationPipe(updateSchema)) body: UpdateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const updated = await this.quotes.update(u.orgId, u.userId, quoteId, body);
    if (!updated) throw new NotFoundException("Quote not found");
    return updated;
  }

  @Delete(":quoteId")
  @RequirePermission("crm:quotes:delete")
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
  async send(
    @Param("quoteId", ParseIntPipe) quoteId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.quotes.send(u.orgId, u.userId, quoteId);
    if (!result) throw new NotFoundException("Quote not found");
    if (isSendNotDraft(result)) throw new BadRequestException("Only draft quotes can be sent");
    return result;
  }
}
