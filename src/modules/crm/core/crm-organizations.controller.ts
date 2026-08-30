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
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { CrmOrganizationsService } from "./crm-organizations.service";
import { CrmOrganizationsInsightsService } from "./crm-organizations-insights.service";
import {
  organizationCreateSchema,
  organizationListSchema,
  organizationUpdateSchema,
  mergeOrgsSchema,
  orgDuplicatesQuerySchema,
  orgDuplicateCheckSchema,
  type OrganizationCreateInput,
  type OrganizationListInput,
  type OrganizationUpdateInput,
  type MergeOrgsInput,
  type OrgDuplicatesQueryInput,
  type OrgDuplicateCheckInput,
} from "./dto/organizations.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const organizationIdParams = z.object({ organizationId: z.coerce.number().int().positive() }).strict();

@RequireModule("crm")
@Controller("crm/organizations")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class CrmOrganizationsController {
  constructor(
    private readonly orgs: CrmOrganizationsService,
    private readonly insights: CrmOrganizationsInsightsService,
  ) {}

  @Get()
  @RequirePermission("crm:organizations:view")
  list(
    @Query(new ZodValidationPipe(organizationListSchema)) query: OrganizationListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.orgs.list(u.orgId, query);
  }

  @Post()
  @RequirePermission("crm:organizations:manage")
  @HttpCode(201)
  @Idempotent("crm.org.create")
  create(
    @Body(new ZodValidationPipe(organizationCreateSchema)) body: OrganizationCreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.orgs.create(u.orgId, body);
  }

  @Get("duplicates")
  @RequirePermission("crm:organizations:view")
  getDuplicates(
    @Query(new ZodValidationPipe(orgDuplicatesQuerySchema)) query: OrgDuplicatesQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.orgs.getDuplicateOrgs(u.orgId, query);
  }

  /**
   * Pre-submit check so the form can warn before creating. Same criteria the
   * create path applies, exposed separately so the UI does not have to create
   * a record to discover it is a probable duplicate.
   */
  @Get("duplicate-check")
  @RequirePermission("crm:organizations:view")
  checkDuplicate(
    @Query(new ZodValidationPipe(orgDuplicateCheckSchema)) query: OrgDuplicateCheckInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.orgs.findPotentialDuplicates(u.orgId, query);
  }

  @Post("merge")
  @HttpCode(200)
  @RequirePermission("crm:organizations:merge")
  mergeOrganizations(
    @Body(new ZodValidationPipe(mergeOrgsSchema)) body: MergeOrgsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.orgs.mergeOrganizations(u.orgId, body, u.userId);
  }

  @Get(":organizationId")
  @RequirePermission("crm:organizations:view")
  @Validate({ params: organizationIdParams })
  async getOne(
    @Param("organizationId", ParseIntPipe) organizationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const org = await this.orgs.getWithContacts(u.orgId, organizationId);
    if (!org) throw new NotFoundException("Organization not found");
    return org;
  }

  @Patch(":organizationId")
  @RequirePermission("crm:organizations:manage")
  @Validate({ params: organizationIdParams })
  async update(
    @Param("organizationId", ParseIntPipe) organizationId: number,
    @Body(new ZodValidationPipe(organizationUpdateSchema)) body: OrganizationUpdateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const exists = await this.orgs.exists(u.orgId, organizationId);
    if (!exists) throw new NotFoundException("Organization not found");

    if (body.parentId !== undefined && body.parentId !== null) {
      const cycle = await this.insights.wouldCreateCycle(u.orgId, organizationId, body.parentId);
      if (cycle) {
        throw new BadRequestException(
          "Setting this parent would create a circular dependency. Choose a different parent.",
        );
      }
    }

    return this.orgs.applyUpdate(u.orgId, organizationId, body);
  }

  @Delete(":organizationId")
  @HttpCode(204)
  @RequirePermission("crm:organizations:manage")
  @Validate({ params: organizationIdParams })
  async remove(
    @Param("organizationId", ParseIntPipe) organizationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const removed = await this.orgs.remove(u.orgId, organizationId);
    if (!removed) throw new NotFoundException("Organization not found");
  }

  @Get(":organizationId/hierarchy")
  @RequirePermission("crm:organizations:view")
  @Validate({ params: organizationIdParams })
  async hierarchy(
    @Param("organizationId", ParseIntPipe) organizationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const tree = await this.insights.getAccountHierarchy(u.orgId, organizationId);
    if (!tree) throw new NotFoundException("Organization not found");
    return tree;
  }

  @Get(":organizationId/related-leads")
  @RequirePermission("crm:organizations:view")
  @Validate({ params: organizationIdParams })
  async relatedLeads(
    @Param("organizationId", ParseIntPipe) organizationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const data = await this.insights.getRelatedLeads(u.orgId, organizationId);
    if (!data) throw new NotFoundException("Organization not found");
    return data;
  }

  @Get(":organizationId/roll-up")
  @RequirePermission("crm:organizations:view")
  @Validate({ params: organizationIdParams })
  rollUp(
    @Param("organizationId", ParseIntPipe) organizationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.insights.getAccountRollup(u.orgId, organizationId);
  }

  @Get(":organizationId/timeline")
  @RequirePermission("crm:organizations:view")
  @Validate({ params: organizationIdParams })
  timeline(
    @Param("organizationId", ParseIntPipe) organizationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.insights.getAccountTimeline(u.orgId, organizationId);
  }
}
