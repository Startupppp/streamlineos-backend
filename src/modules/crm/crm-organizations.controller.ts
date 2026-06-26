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
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { CrmOrganizationsService } from "./crm-organizations.service";
import {
  organizationCreateSchema,
  organizationListSchema,
  organizationUpdateSchema,
  type OrganizationCreateInput,
  type OrganizationListInput,
  type OrganizationUpdateInput,
} from "./dto/organizations.schemas";

@Controller("crm/organizations")
@UseGuards(JwtAuthGuard)
export class CrmOrganizationsController {
  constructor(private readonly orgs: CrmOrganizationsService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(organizationListSchema)) query: OrganizationListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.orgs.list(u.orgId, query);
  }

  @Post()
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(organizationCreateSchema)) body: OrganizationCreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.orgs.create(u.orgId, body);
  }

  @Get(":organizationId")
  async getOne(
    @Param("organizationId", ParseIntPipe) organizationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const org = await this.orgs.getWithContacts(u.orgId, organizationId);
    if (!org) throw new NotFoundException("Organization not found");
    return org;
  }

  @Patch(":organizationId")
  async update(
    @Param("organizationId", ParseIntPipe) organizationId: number,
    @Body(new ZodValidationPipe(organizationUpdateSchema)) body: OrganizationUpdateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const exists = await this.orgs.exists(u.orgId, organizationId);
    if (!exists) throw new NotFoundException("Organization not found");

    if (body.parentId !== undefined && body.parentId !== null) {
      const cycle = await this.orgs.wouldCreateCycle(u.orgId, organizationId, body.parentId);
      if (cycle) {
        throw new BadRequestException(
          "Setting this parent would create a circular dependency. Choose a different parent.",
        );
      }
    }

    return this.orgs.applyUpdate(u.orgId, organizationId, body);
  }

  @Delete(":organizationId")
  async remove(
    @Param("organizationId", ParseIntPipe) organizationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const removed = await this.orgs.remove(u.orgId, organizationId);
    if (!removed) throw new NotFoundException("Organization not found");
    return { success: true };
  }

  @Get(":organizationId/hierarchy")
  async hierarchy(
    @Param("organizationId", ParseIntPipe) organizationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const tree = await this.orgs.getAccountHierarchy(u.orgId, organizationId);
    if (!tree) throw new NotFoundException("Organization not found");
    return tree;
  }

  @Get(":organizationId/related-leads")
  async relatedLeads(
    @Param("organizationId", ParseIntPipe) organizationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const data = await this.orgs.getRelatedLeads(u.orgId, organizationId);
    if (!data) throw new NotFoundException("Organization not found");
    return data;
  }

  @Get(":organizationId/roll-up")
  rollUp(
    @Param("organizationId", ParseIntPipe) organizationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.orgs.getAccountRollup(u.orgId, organizationId);
  }

  @Get(":organizationId/timeline")
  timeline(
    @Param("organizationId", ParseIntPipe) organizationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.orgs.getAccountTimeline(u.orgId, organizationId);
  }
}
