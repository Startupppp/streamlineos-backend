import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  InternalServerErrorException,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { AccessService } from "../access/access.service";
import { ClientAccountsService } from "./client-accounts.service";
import { ClientsService } from "./clients.service";
import { ClientOpportunitiesService } from "./client-opportunities.service";
import { ClientOnboardingService } from "./client-onboarding.service";
import {
  listAccountsSchema,
  healthQuerySchema,
  createActivitySchema,
  updateRenewalSchema,
  opportunitiesListSchema,
  createOpportunitySchema,
  updateOpportunitySchema,
  onboardingItemsListSchema,
  createOnboardingItemSchema,
  patchOnboardingItemSchema,
  createTemplateSchema,
  updateClientStatusSchema,
  type ListAccountsInput,
  type HealthQueryInput,
  type CreateActivityInput,
  type UpdateRenewalInput,
  type OpportunitiesListInput,
  type CreateOpportunityInput,
  type UpdateOpportunityInput,
  type OnboardingItemsListInput,
  type CreateOnboardingItemInput,
  type PatchOnboardingItemInput,
  type CreateTemplateInput,
  type UpdateClientStatusInput,
} from "./dto/clients.schemas";

@Controller("clients")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ClientsController {
  constructor(
    private readonly accounts: ClientAccountsService,
    private readonly clients: ClientsService,
    private readonly opportunities: ClientOpportunitiesService,
    private readonly onboarding: ClientOnboardingService,
    private readonly access: AccessService,
  ) {}

  @Get()
  listAccounts(
    @Query(new ZodValidationPipe(listAccountsSchema)) query: ListAccountsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.accounts.getClientAccounts(u.orgId, u.role, u.userId, query);
  }

  @Get("list")
  listClients(@CurrentUser() u: CurrentUserContext) {
    return this.clients.listClients(u.orgId);
  }

  @Get("health")
  getHealth(
    @Query(new ZodValidationPipe(healthQuerySchema)) query: HealthQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.clients.getHealth(u.orgId, query.status, query.limit);
  }

  @Get("churn-alerts")
  getChurnAlerts(@CurrentUser() u: CurrentUserContext) {
    return this.clients.getChurnAlerts(u.orgId);
  }

  @Get("assign-crm")
  getCrmAssignmentStats(@CurrentUser() u: CurrentUserContext) {
    return this.accounts.getCrmAssignmentStats(u.orgId);
  }

  @Post("assign-crm")
  @HttpCode(200)
  async runCrmAssignments(@CurrentUser() u: CurrentUserContext) {
    try {
      return await this.accounts.runCrmAssignments(u.orgId);
    } catch {
      throw new InternalServerErrorException("Failed to assign CRM reps. Please try again.");
    }
  }

  @Get("renewals")
  listRenewals(@CurrentUser() u: CurrentUserContext) {
    return this.accounts.listRenewals(u.orgId);
  }

  @Patch("renewals/:accountId")
  async updateRenewal(
    @Param("accountId", ParseIntPipe) accountId: number,
    @Body(new ZodValidationPipe(updateRenewalSchema)) body: UpdateRenewalInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("crm:clients:update")) {
        throw new ForbiddenException("Insufficient permissions to update renewal stage");
      }
    }
    const updated = await this.accounts.updateRenewal(u.orgId, accountId, body);
    if (!updated) throw new NotFoundException("Client account not found");
    return updated;
  }

  @Get("opportunities")
  listOpportunities(
    @Query(new ZodValidationPipe(opportunitiesListSchema)) query: OpportunitiesListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.opportunities.list(u.orgId, query.clientId);
  }

  @Post("opportunities")
  @HttpCode(201)
  async createOpportunity(
    @Body(new ZodValidationPipe(createOpportunitySchema)) body: CreateOpportunityInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const created = await this.opportunities.create(u.orgId, u.userId, body);
    if (!created) throw new NotFoundException("Client not found");
    return created;
  }

  @Patch("opportunities/:oppId")
  async updateOpportunity(
    @Param("oppId", ParseIntPipe) oppId: number,
    @Body(new ZodValidationPipe(updateOpportunitySchema)) body: UpdateOpportunityInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const updated = await this.opportunities.update(u.orgId, oppId, body);
    if (!updated) throw new NotFoundException("Opportunity not found");
    return updated;
  }

  @Delete("opportunities/:oppId")
  async deleteOpportunity(
    @Param("oppId", ParseIntPipe) oppId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.opportunities.remove(u.orgId, oppId);
    if (!result) throw new NotFoundException("Opportunity not found");
    return result;
  }

  @Get("onboarding/items")
  listOnboardingItems(
    @Query(new ZodValidationPipe(onboardingItemsListSchema)) query: OnboardingItemsListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.onboarding.listItems(u.orgId, query.clientId);
  }

  @Post("onboarding/items")
  @HttpCode(201)
  createOnboardingItem(
    @Body(new ZodValidationPipe(createOnboardingItemSchema)) body: CreateOnboardingItemInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.onboarding.createItem(u.orgId, body);
  }

  @Patch("onboarding/items/:itemId")
  async updateOnboardingItem(
    @Param("itemId", ParseIntPipe) itemId: number,
    @Body(new ZodValidationPipe(patchOnboardingItemSchema)) body: PatchOnboardingItemInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const updated = await this.onboarding.updateItem(u.orgId, u.userId, itemId, body);
    if (!updated) throw new NotFoundException("Not found");
    return updated;
  }

  @Delete("onboarding/items/:itemId")
  async deleteOnboardingItem(
    @Param("itemId", ParseIntPipe) itemId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.onboarding.deleteItem(u.orgId, itemId);
    if (!result) throw new NotFoundException("Not found");
    return result;
  }

  @Get("onboarding/templates")
  listOnboardingTemplates(@CurrentUser() u: CurrentUserContext) {
    return this.onboarding.listTemplates(u.orgId);
  }

  @Post("onboarding/templates")
  @HttpCode(201)
  @RequirePermission("settings:manage")
  createOnboardingTemplate(
    @Body(new ZodValidationPipe(createTemplateSchema)) body: CreateTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.onboarding.createTemplate(u.orgId, u.userId, body);
  }

  @Get(":clientId")
  async getClientAccount(
    @Param("clientId", ParseIntPipe) clientId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const account = await this.accounts.getClientAccount(u.orgId, clientId);
    if (!account) throw new NotFoundException("Client account not found");
    if (u.role === "SALES" && account.salesRepId !== u.userId) {
      throw new ForbiddenException("You can only view your own converted clients");
    }
    return account;
  }

  @Patch(":clientId")
  async updateClientStatus(
    @Param("clientId", ParseIntPipe) clientId: number,
    @Body(new ZodValidationPipe(updateClientStatusSchema)) body: UpdateClientStatusInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("crm:clients:manage")) {
        throw new ForbiddenException("Only CRM team can update client status");
      }
    }
    const updated = await this.accounts.updateStatus(u.orgId, u.userId, clientId, body);
    if (!updated) throw new NotFoundException("Client account not found");
    return updated;
  }

  @Get(":clientId/activities")
  getClientActivities(
    @Param("clientId", ParseIntPipe) clientId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.accounts.getClientActivities(u.orgId, clientId);
  }

  @Post(":clientId/activities")
  @HttpCode(201)
  async createClientActivity(
    @Param("clientId", ParseIntPipe) clientId: number,
    @Body(new ZodValidationPipe(createActivitySchema)) body: CreateActivityInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("crm:clients:update")) {
        throw new ForbiddenException("Forbidden");
      }
    }
    const activity = await this.accounts.addActivity(u.orgId, clientId, u.userId, body);
    if (!activity) throw new NotFoundException("Client account not found");
    return activity;
  }

  @Get(":clientId/timeline")
  async getClientTimeline(
    @Param("clientId", ParseIntPipe) clientId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.clients.getTimeline(u.orgId, clientId);
    if (!result) throw new NotFoundException("Client not found");
    return result;
  }
}
