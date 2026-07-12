import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { CrmPricebooksService } from "./crm-pricebooks.service";
import {
  createPricebookSchema,
  updatePricebookSchema,
  upsertEntrySchema,
  resolvePriceQuerySchema,
  quoteSettingsSchema,
  createTemplateSchema,
  updateTemplateSchema,
  type CreatePricebookInput,
  type UpdatePricebookInput,
  type UpsertEntryInput,
  type ResolvePriceQuery,
  type QuoteSettingsInput,
  type CreateTemplateInput,
  type UpdateTemplateInput,
} from "./dto/pricebooks.schemas";

@RequireModule("crm")
@Controller("crm")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class CrmPricebooksController {
  constructor(private readonly service: CrmPricebooksService) {}

  @Get("pricebooks/resolve-price")
  @RequirePermission("crm:quotes:create")
  resolvePrice(
    @Query(new ZodValidationPipe(resolvePriceQuerySchema)) query: ResolvePriceQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.resolvePrice(u.orgId, query);
  }

  @Get("pricebooks")
  @RequirePermission("crm:pricebooks:manage")
  listPricebooks(@CurrentUser() u: CurrentUserContext) {
    return this.service.listPricebooks(u.orgId);
  }

  @Post("pricebooks")
  @HttpCode(201)
  @RequirePermission("crm:pricebooks:manage")
  createPricebook(
    @Body(new ZodValidationPipe(createPricebookSchema)) body: CreatePricebookInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.createPricebook(u.orgId, body);
  }

  @Patch("pricebooks/:pricebookId")
  @RequirePermission("crm:pricebooks:manage")
  updatePricebook(
    @Param("pricebookId") pricebookId: string,
    @Body(new ZodValidationPipe(updatePricebookSchema)) body: UpdatePricebookInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.updatePricebook(u.orgId, pricebookId, body);
  }

  @Delete("pricebooks/:pricebookId")
  @RequirePermission("crm:pricebooks:manage")
  deletePricebook(
    @Param("pricebookId") pricebookId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.deletePricebook(u.orgId, pricebookId);
  }

  @Get("pricebooks/:pricebookId/entries")
  @RequirePermission("crm:pricebooks:manage")
  listEntries(
    @Param("pricebookId") pricebookId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.listEntries(u.orgId, pricebookId);
  }

  @Post("pricebooks/:pricebookId/entries")
  @HttpCode(200)
  @RequirePermission("crm:pricebooks:manage")
  upsertEntry(
    @Param("pricebookId") pricebookId: string,
    @Body(new ZodValidationPipe(upsertEntrySchema)) body: UpsertEntryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.upsertEntry(u.orgId, pricebookId, body);
  }

  @Delete("pricebooks/:pricebookId/entries/:entryId")
  @RequirePermission("crm:pricebooks:manage")
  deleteEntry(
    @Param("pricebookId") pricebookId: string,
    @Param("entryId") entryId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.deleteEntry(u.orgId, pricebookId, entryId);
  }

  @Get("quote-settings")
  @RequirePermission("crm:pricebooks:manage")
  getQuoteSettings(@CurrentUser() u: CurrentUserContext) {
    return this.service.getQuoteSettings(u.orgId);
  }

  @Patch("quote-settings")
  @RequirePermission("crm:pricebooks:manage")
  upsertQuoteSettings(
    @Body(new ZodValidationPipe(quoteSettingsSchema)) body: QuoteSettingsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.upsertQuoteSettings(u.orgId, body);
  }

  @Get("quote-templates")
  @RequirePermission("crm:pricebooks:manage")
  listTemplates(@CurrentUser() u: CurrentUserContext) {
    return this.service.listTemplates(u.orgId);
  }

  @Post("quote-templates")
  @HttpCode(201)
  @RequirePermission("crm:pricebooks:manage")
  createTemplate(
    @Body(new ZodValidationPipe(createTemplateSchema)) body: CreateTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.createTemplate(u.orgId, body);
  }

  @Patch("quote-templates/:templateId")
  @RequirePermission("crm:pricebooks:manage")
  updateTemplate(
    @Param("templateId") templateId: string,
    @Body(new ZodValidationPipe(updateTemplateSchema)) body: UpdateTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.updateTemplate(u.orgId, templateId, body);
  }

  @Delete("quote-templates/:templateId")
  @RequirePermission("crm:pricebooks:manage")
  deleteTemplate(
    @Param("templateId") templateId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.deleteTemplate(u.orgId, templateId);
  }
}
