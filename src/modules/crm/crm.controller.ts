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
import { AbilityGuard } from "../../common/rbac/ability.guard";
import { CheckAbility } from "../../common/rbac/check-ability.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { CrmOrganizationsService, isOrgCycle, isOrgNotFound } from "./crm-organizations.service";
import { CrmAccountsService } from "./crm-accounts.service";
import { CrmPeopleService } from "./crm-people.service";
import { CrmDashboardsService } from "./crm-dashboards.service";
import { CrmConfigService } from "./crm-config.service";
import {
  organizationListSchema,
  organizationCreateSchema,
  organizationUpdateSchema,
  territoryListSchema,
  territoryCreateSchema,
  territoryUpdateSchema,
  slaCreateSchema,
  slaUpdateSchema,
  scoringRuleCreateSchema,
  scoringRuleUpdateSchema,
  assignmentRuleCreateSchema,
  assignmentRuleUpdateSchema,
  assignmentRuleReorderSchema,
  emailTemplateCreateSchema,
  emailTemplateUpdateSchema,
  webFormCreateSchema,
  webFormUpdateSchema,
  type OrganizationListInput,
  type OrganizationCreateInput,
  type OrganizationUpdateInput,
  type TerritoryListInput,
  type TerritoryCreateInput,
  type TerritoryUpdateInput,
  type SlaCreateInput,
  type SlaUpdateInput,
  type ScoringRuleCreateInput,
  type ScoringRuleUpdateInput,
  type AssignmentRuleCreateInput,
  type AssignmentRuleUpdateInput,
  type AssignmentRuleReorderInput,
  type EmailTemplateCreateInput,
  type EmailTemplateUpdateInput,
  type WebFormCreateInput,
  type WebFormUpdateInput,
} from "./dto/crm.schemas";

@Controller("crm")
@UseGuards(JwtAuthGuard)
export class CrmController {
  constructor(
    private readonly organizations: CrmOrganizationsService,
    private readonly accounts: CrmAccountsService,
    private readonly people: CrmPeopleService,
    private readonly dashboards: CrmDashboardsService,
    private readonly config: CrmConfigService,
  ) {}

  @Get("organizations")
  listOrganizations(
    @Query(new ZodValidationPipe(organizationListSchema)) query: OrganizationListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.organizations.list(u.orgId, query.page, query.pageSize, query.search ?? query.q ?? "");
  }

  @Post("organizations")
  @HttpCode(201)
  createOrganization(
    @Body(new ZodValidationPipe(organizationCreateSchema)) body: OrganizationCreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.organizations.create(u.orgId, body);
  }

  @Get("organizations/:organizationId")
  async getOrganization(
    @Param("organizationId", ParseIntPipe) organizationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const org = await this.organizations.getDetail(u.orgId, organizationId);
    if (!org) throw new NotFoundException("Organization not found");
    return org;
  }

  @Patch("organizations/:organizationId")
  async updateOrganization(
    @Param("organizationId", ParseIntPipe) organizationId: number,
    @Body(new ZodValidationPipe(organizationUpdateSchema)) body: OrganizationUpdateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.organizations.update(u.orgId, organizationId, body);
    if (isOrgNotFound(result)) throw new NotFoundException("Organization not found");
    if (isOrgCycle(result)) {
      throw new BadRequestException(
        "Setting this parent would create a circular dependency. Choose a different parent.",
      );
    }
    return result;
  }

  @Delete("organizations/:organizationId")
  async removeOrganization(
    @Param("organizationId", ParseIntPipe) organizationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.organizations.remove(u.orgId, organizationId);
    if (!result) throw new NotFoundException("Organization not found");
    return result;
  }

  @Get("organizations/:organizationId/hierarchy")
  async organizationHierarchy(
    @Param("organizationId", ParseIntPipe) organizationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const tree = await this.accounts.getAccountHierarchy(u.orgId, organizationId);
    if (!tree) throw new NotFoundException("Organization not found");
    return tree;
  }

  @Get("organizations/:organizationId/related-leads")
  async organizationRelatedLeads(
    @Param("organizationId", ParseIntPipe) organizationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.organizations.getRelatedLeads(u.orgId, organizationId);
    if (!result) throw new NotFoundException("Organization not found");
    return result;
  }

  @Get("organizations/:organizationId/roll-up")
  organizationRollup(
    @Param("organizationId", ParseIntPipe) organizationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.accounts.getAccountRollup(u.orgId, organizationId);
  }

  @Get("organizations/:organizationId/timeline")
  organizationTimeline(
    @Param("organizationId", ParseIntPipe) organizationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.accounts.getAccountTimeline(u.orgId, organizationId);
  }

  @Get("people-slugs")
  peopleSlugs(@CurrentUser() u: CurrentUserContext) {
    return this.people.getAllPeopleSlugs(u.orgId);
  }

  @Get("people/:entityId")
  async person(@Param("entityId") entityId: string, @CurrentUser() u: CurrentUserContext) {
    const data = await this.people.getPersonBySlug(u.orgId, entityId);
    if (!data) throw new NotFoundException("Person not found");
    return data;
  }

  @Get("sales-dashboard")
  salesDashboard(@CurrentUser() u: CurrentUserContext) {
    return this.dashboards.getSalesDashboard(u.orgId);
  }

  @Get("support-dashboard")
  supportDashboard(@CurrentUser() u: CurrentUserContext) {
    return this.dashboards.getSupportDashboard(u.orgId);
  }

  @Get("customer-executive")
  customerExecutiveDashboard(@CurrentUser() u: CurrentUserContext) {
    return this.dashboards.getCustomerExecutiveDashboard(u.orgId);
  }

  @Get("territories")
  listTerritories(
    @Query(new ZodValidationPipe(territoryListSchema)) query: TerritoryListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.config.listTerritories(u.orgId, query.limit);
  }

  @Post("territories")
  @HttpCode(201)
  createTerritory(
    @Body(new ZodValidationPipe(territoryCreateSchema)) body: TerritoryCreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.config.createTerritory(u.orgId, u.userId, body);
  }

  @Get("territories/:territoryId")
  async getTerritory(
    @Param("territoryId", ParseIntPipe) territoryId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const row = await this.config.getTerritory(u.orgId, territoryId);
    if (!row) throw new NotFoundException("Territory not found");
    return row;
  }

  @Patch("territories/:territoryId")
  async updateTerritory(
    @Param("territoryId", ParseIntPipe) territoryId: number,
    @Body(new ZodValidationPipe(territoryUpdateSchema)) body: TerritoryUpdateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const updated = await this.config.updateTerritory(u.orgId, territoryId, body);
    if (!updated) throw new NotFoundException("Territory not found");
    return updated;
  }

  @Delete("territories/:territoryId")
  async removeTerritory(
    @Param("territoryId", ParseIntPipe) territoryId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.config.removeTerritory(u.orgId, territoryId);
    if (!result) throw new NotFoundException("Territory not found");
    return result;
  }

  @Get("sla/policies")
  listSlaPolicies(@CurrentUser() u: CurrentUserContext) {
    return this.config.listSlaPolicies(u.orgId);
  }

  @Post("sla/policies")
  @UseGuards(AbilityGuard)
  @CheckAbility("manage", "crm:sla")
  @HttpCode(201)
  createSlaPolicy(
    @Body(new ZodValidationPipe(slaCreateSchema)) body: SlaCreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.config.createSlaPolicy(u.orgId, body);
  }

  @Patch("sla/policies/:policyId")
  @UseGuards(AbilityGuard)
  @CheckAbility("manage", "crm:sla")
  async updateSlaPolicy(
    @Param("policyId", ParseIntPipe) policyId: number,
    @Body(new ZodValidationPipe(slaUpdateSchema)) body: SlaUpdateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const updated = await this.config.updateSlaPolicy(u.orgId, policyId, body);
    if (!updated) throw new NotFoundException("Policy not found");
    return updated;
  }

  @Delete("sla/policies/:policyId")
  @UseGuards(AbilityGuard)
  @CheckAbility("manage", "crm:sla")
  removeSlaPolicy(
    @Param("policyId", ParseIntPipe) policyId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.config.removeSlaPolicy(u.orgId, policyId);
  }

  @Get("sla/breached")
  breachedSla(@CurrentUser() u: CurrentUserContext) {
    return this.config.getBreachedSla(u.orgId);
  }

  @Get("sla/report")
  slaReport(@CurrentUser() u: CurrentUserContext) {
    return this.config.getSlaReport(u.orgId);
  }

  @Get("scoring-rules")
  listScoringRules(@CurrentUser() u: CurrentUserContext) {
    return this.config.listScoringRules(u.orgId);
  }

  @Post("scoring-rules")
  @UseGuards(AbilityGuard)
  @CheckAbility("manage", "crm:scoring-rules")
  @HttpCode(201)
  createScoringRule(
    @Body(new ZodValidationPipe(scoringRuleCreateSchema)) body: ScoringRuleCreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.config.createScoringRule(u.orgId, body);
  }

  @Patch("scoring-rules/:ruleId")
  @UseGuards(AbilityGuard)
  @CheckAbility("manage", "crm:scoring-rules")
  async updateScoringRule(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @Body(new ZodValidationPipe(scoringRuleUpdateSchema)) body: ScoringRuleUpdateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const updated = await this.config.updateScoringRule(u.orgId, ruleId, body);
    if (!updated) throw new NotFoundException("Rule not found");
    return updated;
  }

  @Delete("scoring-rules/:ruleId")
  @UseGuards(AbilityGuard)
  @CheckAbility("manage", "crm:scoring-rules")
  removeScoringRule(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.config.removeScoringRule(u.orgId, ruleId);
  }

  @Get("assignment-rules")
  listAssignmentRules(@CurrentUser() u: CurrentUserContext) {
    return this.config.listAssignmentRules(u.orgId);
  }

  @Post("assignment-rules")
  @UseGuards(AbilityGuard)
  @CheckAbility("manage", "crm:assignment-rules")
  @HttpCode(201)
  createAssignmentRule(
    @Body(new ZodValidationPipe(assignmentRuleCreateSchema)) body: AssignmentRuleCreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.config.createAssignmentRule(u.orgId, body);
  }

  @Patch("assignment-rules/reorder")
  @UseGuards(AbilityGuard)
  @CheckAbility("manage", "crm:assignment-rules")
  reorderAssignmentRules(
    @Body(new ZodValidationPipe(assignmentRuleReorderSchema)) body: AssignmentRuleReorderInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.config.reorderAssignmentRules(u.orgId, body.ruleIds);
  }

  @Patch("assignment-rules/:ruleId")
  @UseGuards(AbilityGuard)
  @CheckAbility("manage", "crm:assignment-rules")
  async updateAssignmentRule(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @Body(new ZodValidationPipe(assignmentRuleUpdateSchema)) body: AssignmentRuleUpdateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const updated = await this.config.updateAssignmentRule(u.orgId, ruleId, body);
    if (!updated) throw new NotFoundException("Rule not found");
    return updated;
  }

  @Delete("assignment-rules/:ruleId")
  @UseGuards(AbilityGuard)
  @CheckAbility("manage", "crm:assignment-rules")
  removeAssignmentRule(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.config.removeAssignmentRule(u.orgId, ruleId);
  }

  @Get("email-templates")
  listEmailTemplates(@CurrentUser() u: CurrentUserContext) {
    return this.config.listEmailTemplates(u.orgId);
  }

  @Post("email-templates")
  @UseGuards(AbilityGuard)
  @CheckAbility("manage", "crm:email-templates")
  @HttpCode(201)
  createEmailTemplate(
    @Body(new ZodValidationPipe(emailTemplateCreateSchema)) body: EmailTemplateCreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.config.createEmailTemplate(u.orgId, u.userId, body);
  }

  @Patch("email-templates/:templateId")
  @UseGuards(AbilityGuard)
  @CheckAbility("manage", "crm:email-templates")
  async updateEmailTemplate(
    @Param("templateId", ParseIntPipe) templateId: number,
    @Body(new ZodValidationPipe(emailTemplateUpdateSchema)) body: EmailTemplateUpdateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const updated = await this.config.updateEmailTemplate(u.orgId, templateId, body);
    if (!updated) throw new NotFoundException("Template not found");
    return updated;
  }

  @Delete("email-templates/:templateId")
  @UseGuards(AbilityGuard)
  @CheckAbility("manage", "crm:email-templates")
  removeEmailTemplate(
    @Param("templateId", ParseIntPipe) templateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.config.removeEmailTemplate(u.orgId, templateId);
  }

  @Get("web-forms")
  listWebForms(@CurrentUser() u: CurrentUserContext) {
    return this.config.listWebForms(u.orgId);
  }

  @Post("web-forms")
  @HttpCode(201)
  createWebForm(
    @Body(new ZodValidationPipe(webFormCreateSchema)) body: WebFormCreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.config.createWebForm(u.orgId, u.userId, body);
  }

  @Get("web-forms/:formId")
  async getWebForm(
    @Param("formId", ParseIntPipe) formId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const form = await this.config.getWebForm(u.orgId, formId);
    if (!form) throw new NotFoundException("Form not found");
    return form;
  }

  @Patch("web-forms/:formId")
  async updateWebForm(
    @Param("formId", ParseIntPipe) formId: number,
    @Body(new ZodValidationPipe(webFormUpdateSchema)) body: WebFormUpdateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const updated = await this.config.updateWebForm(u.orgId, formId, body);
    if (!updated) throw new NotFoundException("Form not found");
    return updated;
  }

  @Delete("web-forms/:formId")
  async removeWebForm(
    @Param("formId", ParseIntPipe) formId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.config.removeWebForm(u.orgId, formId);
    if (!result) throw new NotFoundException("Form not found");
    return result;
  }
}
