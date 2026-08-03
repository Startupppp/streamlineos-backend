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
import { CrmOrgMergeService } from "./crm-org-merge.service";
import {
  organizationCreateSchema,
  organizationListSchema,
  organizationUpdateSchema,
  type OrganizationCreateInput,
  type OrganizationListInput,
  type OrganizationUpdateInput,
} from "./dto/organizations.schemas";
import {
  mergeOrgsSchema,
  orgDuplicatesQuerySchema,
  type MergeOrgsInput,
  type OrgDuplicatesQueryInput,
} from "./dto/org-merge.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";

@RequireModule("crm")
@Controller("crm/organizations")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class CrmOrganizationsController {
  constructor(
    private readonly orgs: CrmOrganizationsService,
    private readonly orgMerge: CrmOrgMergeService,
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
    return this.orgMerge.getDuplicateOrgs(u.orgId, query);
  }

  @Post("merge")
  @HttpCode(200)
  @RequirePermission("crm:organizations:merge")
  mergeOrganizations(
    @Body(new ZodValidationPipe(mergeOrgsSchema)) body: MergeOrgsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.orgMerge.mergeOrganizations(u.orgId, body, u.userId);
  }

  @Get(":organizationId")
  @RequirePermission("crm:organizations:view")
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
  @HttpCode(204)
  @RequirePermission("crm:organizations:manage")
  async remove(
    @Param("organizationId", ParseIntPipe) organizationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const removed = await this.orgs.remove(u.orgId, organizationId);
    if (!removed) throw new NotFoundException("Organization not found");
  }

  @Get(":organizationId/hierarchy")
  @RequirePermission("crm:organizations:view")
  async hierarchy(
    @Param("organizationId", ParseIntPipe) organizationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const tree = await this.orgs.getAccountHierarchy(u.orgId, organizationId);
    if (!tree) throw new NotFoundException("Organization not found");
    return tree;
  }

  @Get(":organizationId/related-leads")
  @RequirePermission("crm:organizations:view")
  async relatedLeads(
    @Param("organizationId", ParseIntPipe) organizationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const data = await this.orgs.getRelatedLeads(u.orgId, organizationId);
    if (!data) throw new NotFoundException("Organization not found");
    return data;
  }

  @Get(":organizationId/roll-up")
  @RequirePermission("crm:organizations:view")
  rollUp(
    @Param("organizationId", ParseIntPipe) organizationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.orgs.getAccountRollup(u.orgId, organizationId);
  }

  @Get(":organizationId/timeline")
  @RequirePermission("crm:organizations:view")
  timeline(
    @Param("organizationId", ParseIntPipe) organizationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.orgs.getAccountTimeline(u.orgId, organizationId);
  }
}
