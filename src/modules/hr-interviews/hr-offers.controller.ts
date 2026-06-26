import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { defineAbilityFor } from "../../common/rbac/abilities.factory";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { HrOffersService } from "./hr-offers.service";
import { RECRUITMENT_MANAGER_ROLES } from "./recruitment-roles";
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

@Controller("hr/recruitment")
@UseGuards(JwtAuthGuard)
export class HrOffersController {
  constructor(private readonly offers: HrOffersService) {}

  @Get("offer-templates")
  listTemplates(@CurrentUser() u: CurrentUserContext) {
    return this.offers.listTemplates(u.orgId);
  }

  @Post("offer-templates")
  @HttpCode(201)
  createTemplate(
    @Body(new ZodValidationPipe(createOfferTemplateSchema)) body: CreateOfferTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!RECRUITMENT_MANAGER_ROLES.includes(u.role)) {
      throw new ForbiddenException("Forbidden");
    }
    return this.offers.createTemplate(u.orgId, u.userId, body);
  }

  @Patch("offer-templates/:templateId")
  updateTemplate(
    @Param("templateId", ParseIntPipe) templateId: number,
    @Body(new ZodValidationPipe(updateOfferTemplateSchema)) body: UpdateOfferTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!RECRUITMENT_MANAGER_ROLES.includes(u.role)) {
      throw new ForbiddenException("Forbidden");
    }
    return this.offers.updateTemplate(u.orgId, templateId, body);
  }

  @Delete("offer-templates/:templateId")
  deleteTemplate(
    @Param("templateId", ParseIntPipe) templateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!RECRUITMENT_MANAGER_ROLES.includes(u.role)) {
      throw new ForbiddenException("Forbidden");
    }
    return this.offers.deleteTemplate(u.orgId, templateId);
  }

  @Post("offer-templates/:templateId/generate-pdf")
  @HttpCode(200)
  generatePdf(
    @Param("templateId", ParseIntPipe) templateId: number,
    @Body(new ZodValidationPipe(generateOfferPdfSchema)) body: GenerateOfferPdfInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.offers.generatePdf(u.orgId, templateId, body);
  }

  @Post("offer-letter")
  @HttpCode(201)
  generateOfferLetter(
    @Body(new ZodValidationPipe(offerLetterSchema)) body: OfferLetterInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const ability = defineAbilityFor(u);
    if (!ability.can("manage", "hr:employees")) {
      throw new ForbiddenException("Only admins can generate offer letters.");
    }
    return this.offers.generateOfferLetter(u.orgId, u.userId, body);
  }
}
