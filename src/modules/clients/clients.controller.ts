import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
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
import { AccessService } from "../access/access.service";
import { ClientAccountsService } from "./client-accounts.service";
import { ClientsService } from "./clients.service";
import { resolveClientsReadScope } from "./clients-scope";
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
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { Deprecated } from "../../common/deprecation/deprecated.decorator";
import { Validate } from "../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction } from "../../common/openapi/zod-operation-contracts";

const accountIdParams = z.object({ accountId: z.coerce.number().int().positive() }).strict();
const oppIdParams = z.object({ oppId: z.coerce.number().int().positive() }).strict();
const itemIdParams = z.object({ itemId: z.coerce.number().int().positive() }).strict();
const clientIdParams = z.object({ clientId: z.coerce.number().int().positive() }).strict();

@RequireModule("crm")
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

  @Deprecated({ sunset: "2026-10-25", link: "/crm/organizations" })
  @Get()
  @RequirePermission("crm:clients:read")
  @Validate({ query: listAccountsSchema })
  async listAccounts(
    @Query() query: ListAccountsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const scope = await resolveClientsReadScope(this.access, u);
    return this.accounts.getClientAccounts(u.orgId, scope, u.userId, query);
  }

  @Deprecated({ sunset: "2026-10-25", link: "/crm/organizations" })
  @Get("list")
  @RequirePermission("crm:clients:read")
  async listClients(@CurrentUser() u: CurrentUserContext) {
    const scope = await resolveClientsReadScope(this.access, u);
    return this.clients.listClients(u.orgId, u.userId, scope);
  }

  @Get("export")
  @RequirePermission("crm:clients:read")
  @Header("Content-Type", "text/csv; charset=utf-8")
  @Header("Content-Disposition", 'attachment; filename="clients-export.csv"')
  exportCsv(@CurrentUser() u: CurrentUserContext) {
    return this.clients.exportCsv(u.orgId);
  }

  @Get("health")
  @RequirePermission("crm:clients:read")
  @Validate({ query: healthQuerySchema })
  async getHealth(
    @Query() query: HealthQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const scope = await resolveClientsReadScope(this.access, u);
    return this.clients.getHealth(u.orgId, query.status, query.limit, u.userId, scope);
  }

  @Get("churn-alerts")
  @RequirePermission("crm:clients:read")
  async getChurnAlerts(@CurrentUser() u: CurrentUserContext) {
    const scope = await resolveClientsReadScope(this.access, u);
    return this.clients.getChurnAlerts(u.orgId, u.userId, scope);
  }

  @Get("assign-crm")
  @RequirePermission("crm:clients:read")
  getCrmAssignmentStats(@CurrentUser() u: CurrentUserContext) {
    return this.accounts.getCrmAssignmentStats(u.orgId);
  }

  @Post("assign-crm")
  @BodylessAction()
  @HttpCode(200)
  @RequirePermission("crm:clients:manage")
  async runCrmAssignments(@CurrentUser() u: CurrentUserContext) {
    try {
      return await this.accounts.runCrmAssignments(u.orgId);
    } catch {
      throw new InternalServerErrorException("Failed to assign CRM reps. Please try again.");
    }
  }

  @Get("renewals")
  @RequirePermission("crm:clients:read")
  async listRenewals(@CurrentUser() u: CurrentUserContext) {
    const scope = await resolveClientsReadScope(this.access, u);
    return this.accounts.listRenewals(u.orgId, scope, u.userId);
  }

  @Patch("renewals/:accountId")
  @RequirePermission("crm:clients:update")
  @Validate({ params: accountIdParams, body: updateRenewalSchema })
  async updateRenewal(
    @Param("accountId", ParseIntPipe) accountId: number,
    @Body() body: UpdateRenewalInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const updated = await this.accounts.updateRenewal(u.orgId, accountId, body);
    if (!updated) throw new NotFoundException("Client account not found");
    return updated;
  }

  @Get("opportunities")
  @RequirePermission("crm:clients:read")
  @Validate({ query: opportunitiesListSchema })
  listOpportunities(
    @Query() query: OpportunitiesListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.opportunities.list(u.orgId, query.clientId);
  }

  @Post("opportunities")
  @HttpCode(201)
  @RequirePermission("crm:clients:update")
  @Validate({ body: createOpportunitySchema })
  async createOpportunity(
    @Body() body: CreateOpportunityInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const created = await this.opportunities.create(u.orgId, u.userId, body);
    if (!created) throw new NotFoundException("Client not found");
    return created;
  }

  @Patch("opportunities/:oppId")
  @RequirePermission("crm:clients:update")
  @Validate({ params: oppIdParams, body: updateOpportunitySchema })
  async updateOpportunity(
    @Param("oppId", ParseIntPipe) oppId: number,
    @Body() body: UpdateOpportunityInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const updated = await this.opportunities.update(u.orgId, oppId, body);
    if (!updated) throw new NotFoundException("Opportunity not found");
    return updated;
  }

  @Delete("opportunities/:oppId")
  @HttpCode(204)
  @RequirePermission("crm:clients:update")
  @Validate({ params: oppIdParams })
  async deleteOpportunity(
    @Param("oppId", ParseIntPipe) oppId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.opportunities.remove(u.orgId, oppId);
    if (!result) throw new NotFoundException("Opportunity not found");
  }

  @Get("onboarding/items")
  @RequirePermission("crm:clients:read")
  @Validate({ query: onboardingItemsListSchema })
  listOnboardingItems(
    @Query() query: OnboardingItemsListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.onboarding.listItems(u.orgId, query.clientId);
  }

  @Post("onboarding/items")
  @HttpCode(201)
  @RequirePermission("crm:clients:update")
  @Validate({ body: createOnboardingItemSchema })
  createOnboardingItem(
    @Body() body: CreateOnboardingItemInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.onboarding.createItem(u.orgId, body);
  }

  @Patch("onboarding/items/:itemId")
  @RequirePermission("crm:clients:update")
  @Validate({ params: itemIdParams, body: patchOnboardingItemSchema })
  async updateOnboardingItem(
    @Param("itemId", ParseIntPipe) itemId: number,
    @Body() body: PatchOnboardingItemInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const updated = await this.onboarding.updateItem(u.orgId, u.userId, itemId, body);
    if (!updated) throw new NotFoundException("Not found");
    return updated;
  }

  @Delete("onboarding/items/:itemId")
  @HttpCode(204)
  @RequirePermission("crm:clients:update")
  @Validate({ params: itemIdParams })
  async deleteOnboardingItem(
    @Param("itemId", ParseIntPipe) itemId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.onboarding.deleteItem(u.orgId, itemId);
    if (!result) throw new NotFoundException("Not found");
  }

  @Get("onboarding/templates")
  @RequirePermission("crm:clients:read")
  listOnboardingTemplates(@CurrentUser() u: CurrentUserContext) {
    return this.onboarding.listTemplates(u.orgId);
  }

  @Post("onboarding/templates")
  @HttpCode(201)
  @RequirePermission("settings:manage")
  @Validate({ body: createTemplateSchema })
  createOnboardingTemplate(
    @Body() body: CreateTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.onboarding.createTemplate(u.orgId, u.userId, body);
  }

  @Deprecated({ sunset: "2026-10-25", link: "/crm/organizations/:organizationId" })
  @Get(":clientId")
  @RequirePermission("crm:clients:read")
  @Validate({ params: clientIdParams })
  async getClientAccount(
    @Param("clientId", ParseIntPipe) clientId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const scope = await resolveClientsReadScope(this.access, u);
    const account = await this.accounts.getClientAccount(u.orgId, clientId, scope, u.userId);
    if (!account) throw new NotFoundException("Client account not found");
    return account;
  }

  @Deprecated({ sunset: "2026-10-25", link: "/crm/organizations/:organizationId" })
  @Patch(":clientId")
  @RequirePermission("crm:clients:update")
  @Validate({ params: clientIdParams, body: updateClientStatusSchema })
  async updateClientStatus(
    @Param("clientId", ParseIntPipe) clientId: number,
    @Body() body: UpdateClientStatusInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const updated = await this.accounts.updateStatus(u.orgId, u.userId, clientId, body);
    if (!updated) throw new NotFoundException("Client account not found");
    return updated;
  }

  @Deprecated({ sunset: "2026-10-25", link: "/crm/organizations/:organizationId/timeline" })
  @Get(":clientId/activities")
  @RequirePermission("crm:clients:read")
  @Validate({ params: clientIdParams })
  getClientActivities(
    @Param("clientId", ParseIntPipe) clientId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.accounts.getClientActivities(u.orgId, clientId);
  }

  @Post(":clientId/activities")
  @HttpCode(201)
  @RequirePermission("crm:clients:update")
  @Validate({ params: clientIdParams, body: createActivitySchema })
  async createClientActivity(
    @Param("clientId", ParseIntPipe) clientId: number,
    @Body() body: CreateActivityInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const activity = await this.accounts.addActivity(u.orgId, clientId, u.userId, body);
    if (!activity) throw new NotFoundException("Client account not found");
    return activity;
  }

  @Deprecated({ sunset: "2026-10-25", link: "/crm/organizations/:organizationId/timeline" })
  @Get(":clientId/timeline")
  @RequirePermission("crm:clients:read")
  @Validate({ params: clientIdParams })
  async getClientTimeline(
    @Param("clientId", ParseIntPipe) clientId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.clients.getTimeline(u.orgId, clientId);
    if (!result) throw new NotFoundException("Client not found");
    return result;
  }
}
