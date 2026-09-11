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
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
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
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  pricebookSchema,
  pricebookEntrySchema,
  pricebookEntryWithProductSchema,
  resolvePriceSchema,
  quoteSettingsSchema as quoteSettingsResponseSchema,
  quoteTemplateSchema,
  successSchema,
} from "./dto/crm-pricebooks-response.schemas";

const pricebookIdParams = z.object({ pricebookId: z.string().min(1) }).strict();
const pricebookIdentryIdParams = z.object({ pricebookId: z.string().min(1), entryId: z.string().min(1) }).strict();
const templateIdParams = z.object({ templateId: z.string().min(1) }).strict();

@RequireModule("crm")
@Controller("crm")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class CrmPricebooksController {
  constructor(private readonly service: CrmPricebooksService) {}

  @Get("pricebooks/resolve-price")
  @RequirePermission("crm:quotes:create")
  @ResponseSchema(resolvePriceSchema)
  @Validate({ query: resolvePriceQuerySchema })
  resolvePrice(
    @Query() query: ResolvePriceQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.resolvePrice(u.orgId, query);
  }

  @Get("pricebooks")
  @RequirePermission("crm:pricebooks:manage")
  @ResponseSchema(z.array(pricebookSchema))
  listPricebooks(@CurrentUser() u: CurrentUserContext) {
    return this.service.listPricebooks(u.orgId);
  }

  @Post("pricebooks")
  @HttpCode(201)
  @RequirePermission("crm:pricebooks:manage")
  @Idempotent("crm.pricebook.create")
  @ResponseSchema(pricebookSchema)
  @Validate({ body: createPricebookSchema })
  createPricebook(
    @Body() body: CreatePricebookInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.createPricebook(u.orgId, body);
  }

  @Patch("pricebooks/:pricebookId")
  @RequirePermission("crm:pricebooks:manage")
  @ResponseSchema(pricebookSchema)
  @Validate({ params: pricebookIdParams, body: updatePricebookSchema })
  updatePricebook(
    @Param("pricebookId") pricebookId: string,
    @Body() body: UpdatePricebookInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.updatePricebook(u.orgId, pricebookId, body);
  }

  @Delete("pricebooks/:pricebookId")
  @RequirePermission("crm:pricebooks:manage")
  @ResponseSchema(successSchema)
  @Validate({ params: pricebookIdParams })
  deletePricebook(
    @Param("pricebookId") pricebookId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.deletePricebook(u.orgId, pricebookId);
  }

  @Get("pricebooks/:pricebookId/entries")
  @RequirePermission("crm:pricebooks:manage")
  @ResponseSchema(z.array(pricebookEntryWithProductSchema))
  @Validate({ params: pricebookIdParams })
  listEntries(
    @Param("pricebookId") pricebookId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.listEntries(u.orgId, pricebookId);
  }

  @Post("pricebooks/:pricebookId/entries")
  @HttpCode(200)
  @RequirePermission("crm:pricebooks:manage")
  @ResponseSchema(pricebookEntrySchema)
  @Validate({ params: pricebookIdParams, body: upsertEntrySchema })
  upsertEntry(
    @Param("pricebookId") pricebookId: string,
    @Body() body: UpsertEntryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.upsertEntry(u.orgId, pricebookId, body);
  }

  @Delete("pricebooks/:pricebookId/entries/:entryId")
  @RequirePermission("crm:pricebooks:manage")
  @ResponseSchema(successSchema)
  @Validate({ params: pricebookIdentryIdParams })
  deleteEntry(
    @Param("pricebookId") pricebookId: string,
    @Param("entryId") entryId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.deleteEntry(u.orgId, pricebookId, entryId);
  }

  @Get("quote-settings")
  @RequirePermission("crm:pricebooks:manage")
  @ResponseSchema(quoteSettingsResponseSchema)
  getQuoteSettings(@CurrentUser() u: CurrentUserContext) {
    return this.service.getQuoteSettings(u.orgId);
  }

  @Patch("quote-settings")
  @RequirePermission("crm:pricebooks:manage")
  @ResponseSchema(quoteSettingsResponseSchema)
  @Validate({ body: quoteSettingsSchema })
  upsertQuoteSettings(
    @Body() body: QuoteSettingsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.upsertQuoteSettings(u.orgId, body);
  }

  @Get("quote-templates")
  @RequirePermission("crm:pricebooks:manage")
  @ResponseSchema(z.array(quoteTemplateSchema))
  listTemplates(@CurrentUser() u: CurrentUserContext) {
    return this.service.listTemplates(u.orgId);
  }

  @Post("quote-templates")
  @HttpCode(201)
  @RequirePermission("crm:pricebooks:manage")
  @ResponseSchema(quoteTemplateSchema)
  @Validate({ body: createTemplateSchema })
  createTemplate(
    @Body() body: CreateTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.createTemplate(u.orgId, body);
  }

  @Patch("quote-templates/:templateId")
  @RequirePermission("crm:pricebooks:manage")
  @ResponseSchema(quoteTemplateSchema)
  @Validate({ params: templateIdParams, body: updateTemplateSchema })
  updateTemplate(
    @Param("templateId") templateId: string,
    @Body() body: UpdateTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.updateTemplate(u.orgId, templateId, body);
  }

  @Delete("quote-templates/:templateId")
  @RequirePermission("crm:pricebooks:manage")
  @ResponseSchema(successSchema)
  @Validate({ params: templateIdParams })
  deleteTemplate(
    @Param("templateId") templateId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.deleteTemplate(u.orgId, templateId);
  }
}
