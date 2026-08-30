import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

import { HrOffersService } from "./hr-offers.service";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import {
  createOfferTemplateSchema,
  generateOfferPdfSchema,
  offerLetterSchema,
  updateOfferTemplateSchema,
  type CreateOfferTemplateInput,
  type GenerateOfferPdfInput,
  type OfferLetterInput,
  type UpdateOfferTemplateInput,
} from "./dto/hr-interviews.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const templateIdParams = z.object({ templateId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@Controller("hr/recruitment")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class HrOffersController {
  constructor(private readonly offers: HrOffersService) {}

  @Get("offer-templates")
  @RequirePermission("hr:offers:view")
  listTemplates(@CurrentUser() u: CurrentUserContext) {
    return this.offers.listTemplates(u.orgId);
  }

  @Post("offer-templates")
  @HttpCode(201)
  @RequirePermission("hr:offers:manage")
  createTemplate(
    @Body(new ZodValidationPipe(createOfferTemplateSchema)) body: CreateOfferTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.offers.createTemplate(u.orgId, u.userId, body);
  }

  @Patch("offer-templates/:templateId")
  @RequirePermission("hr:offers:manage")
  @Validate({ params: templateIdParams })
  updateTemplate(
    @Param("templateId", ParseIntPipe) templateId: number,
    @Body(new ZodValidationPipe(updateOfferTemplateSchema)) body: UpdateOfferTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.offers.updateTemplate(u.orgId, templateId, body);
  }

  @Delete("offer-templates/:templateId")
  @RequirePermission("hr:offers:manage")
  @Validate({ params: templateIdParams })
  deleteTemplate(
    @Param("templateId", ParseIntPipe) templateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.offers.deleteTemplate(u.orgId, templateId);
  }

  @Post("offer-templates/:templateId/generate-pdf")
  @HttpCode(200)
  @RequirePermission("hr:offers:manage")
  @Validate({ params: templateIdParams })
  generatePdf(
    @Param("templateId", ParseIntPipe) templateId: number,
    @Body(new ZodValidationPipe(generateOfferPdfSchema)) body: GenerateOfferPdfInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.offers.generatePdf(u.orgId, templateId, body);
  }

  @Post("offer-letter")
  @HttpCode(201)
  @RequirePermission("hr:offers:manage")
  generateOfferLetter(
    @Body(new ZodValidationPipe(offerLetterSchema)) body: OfferLetterInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.offers.generateOfferLetter(u.orgId, u.userId, body);
  }
}
