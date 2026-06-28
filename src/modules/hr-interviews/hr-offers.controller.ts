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
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { AccessService } from "../access/access.service";
import { HrOffersService } from "./hr-offers.service";
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
  constructor(
    private readonly offers: HrOffersService,
    private readonly access: AccessService,
  ) {}

  @Get("offer-templates")
  listTemplates(@CurrentUser() u: CurrentUserContext) {
    return this.offers.listTemplates(u.orgId);
  }

  @Post("offer-templates")
  @HttpCode(201)
  async createTemplate(
    @Body(new ZodValidationPipe(createOfferTemplateSchema)) body: CreateOfferTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("hr:employees:manage")) {
        throw new ForbiddenException("Forbidden");
      }
    }
    return this.offers.createTemplate(u.orgId, u.userId, body);
  }

  @Patch("offer-templates/:templateId")
  async updateTemplate(
    @Param("templateId", ParseIntPipe) templateId: number,
    @Body(new ZodValidationPipe(updateOfferTemplateSchema)) body: UpdateOfferTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("hr:employees:manage")) {
        throw new ForbiddenException("Forbidden");
      }
    }
    return this.offers.updateTemplate(u.orgId, templateId, body);
  }

  @Delete("offer-templates/:templateId")
  async deleteTemplate(
    @Param("templateId", ParseIntPipe) templateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("hr:employees:manage")) {
        throw new ForbiddenException("Forbidden");
      }
    }
    return this.offers.deleteTemplate(u.orgId, templateId);
  }

  @Post("offer-templates/:templateId/generate-pdf")
  @HttpCode(200)
  async generatePdf(
    @Param("templateId", ParseIntPipe) templateId: number,
    @Body(new ZodValidationPipe(generateOfferPdfSchema)) body: GenerateOfferPdfInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("hr:employees:manage")) {
        throw new ForbiddenException("Forbidden");
      }
    }
    return this.offers.generatePdf(u.orgId, templateId, body);
  }

  @Post("offer-letter")
  @HttpCode(201)
  async generateOfferLetter(
    @Body(new ZodValidationPipe(offerLetterSchema)) body: OfferLetterInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("hr:employees:manage")) {
        throw new ForbiddenException("Only admins can generate offer letters.");
      }
    }
    return this.offers.generateOfferLetter(u.orgId, u.userId, body);
  }
}
