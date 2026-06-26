import {
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
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { AbilityGuard } from "../../common/rbac/ability.guard";
import { CheckAbility } from "../../common/rbac/check-ability.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { CrmRulesService } from "./crm-rules.service";
import {
  assignmentReorderSchema,
  assignmentRuleCreateSchema,
  assignmentRuleUpdateSchema,
  emailTemplateCreateSchema,
  emailTemplateUpdateSchema,
  scoringRuleCreateSchema,
  scoringRuleUpdateSchema,
  type AssignmentReorderInput,
  type AssignmentRuleCreateInput,
  type AssignmentRuleUpdateInput,
  type EmailTemplateCreateInput,
  type EmailTemplateUpdateInput,
  type ScoringRuleCreateInput,
  type ScoringRuleUpdateInput,
} from "./dto/rules.schemas";

@Controller("crm")
@UseGuards(JwtAuthGuard)
export class CrmRulesController {
  constructor(private readonly rules: CrmRulesService) {}

  @Get("assignment-rules")
  listAssignmentRules(@CurrentUser() u: CurrentUserContext) {
    return this.rules.listAssignmentRules(u.orgId);
  }

  @Post("assignment-rules")
  @UseGuards(AbilityGuard)
  @CheckAbility("manage", "crm:assignment-rules")
  @HttpCode(201)
  createAssignmentRule(
    @Body(new ZodValidationPipe(assignmentRuleCreateSchema)) body: AssignmentRuleCreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.rules.createAssignmentRule(u.orgId, body);
  }

  @Patch("assignment-rules/reorder")
  @UseGuards(AbilityGuard)
  @CheckAbility("manage", "crm:assignment-rules")
  reorderAssignmentRules(
    @Body(new ZodValidationPipe(assignmentReorderSchema)) body: AssignmentReorderInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.rules.reorderAssignmentRules(u.orgId, body.ruleIds);
  }

  @Patch("assignment-rules/:ruleId")
  @UseGuards(AbilityGuard)
  @CheckAbility("manage", "crm:assignment-rules")
  async updateAssignmentRule(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @Body(new ZodValidationPipe(assignmentRuleUpdateSchema)) body: AssignmentRuleUpdateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const updated = await this.rules.updateAssignmentRule(u.orgId, ruleId, body);
    if (!updated) throw new NotFoundException("Rule not found");
    return updated;
  }

  @Delete("assignment-rules/:ruleId")
  @UseGuards(AbilityGuard)
  @CheckAbility("manage", "crm:assignment-rules")
  deleteAssignmentRule(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.rules.deleteAssignmentRule(u.orgId, ruleId);
  }

  @Get("scoring-rules")
  listScoringRules(@CurrentUser() u: CurrentUserContext) {
    return this.rules.listScoringRules(u.orgId);
  }

  @Post("scoring-rules")
  @UseGuards(AbilityGuard)
  @CheckAbility("manage", "crm:scoring-rules")
  @HttpCode(201)
  createScoringRule(
    @Body(new ZodValidationPipe(scoringRuleCreateSchema)) body: ScoringRuleCreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.rules.createScoringRule(u.orgId, body);
  }

  @Patch("scoring-rules/:ruleId")
  @UseGuards(AbilityGuard)
  @CheckAbility("manage", "crm:scoring-rules")
  async updateScoringRule(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @Body(new ZodValidationPipe(scoringRuleUpdateSchema)) body: ScoringRuleUpdateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const updated = await this.rules.updateScoringRule(u.orgId, ruleId, body);
    if (!updated) throw new NotFoundException("Rule not found");
    return updated;
  }

  @Delete("scoring-rules/:ruleId")
  @UseGuards(AbilityGuard)
  @CheckAbility("manage", "crm:scoring-rules")
  deleteScoringRule(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.rules.deleteScoringRule(u.orgId, ruleId);
  }

  @Get("email-templates")
  listEmailTemplates(@CurrentUser() u: CurrentUserContext) {
    return this.rules.listEmailTemplates(u.orgId);
  }

  @Post("email-templates")
  @UseGuards(AbilityGuard)
  @CheckAbility("manage", "crm:email-templates")
  @HttpCode(201)
  createEmailTemplate(
    @Body(new ZodValidationPipe(emailTemplateCreateSchema)) body: EmailTemplateCreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.rules.createEmailTemplate(u.orgId, u.userId, body);
  }

  @Patch("email-templates/:templateId")
  @UseGuards(AbilityGuard)
  @CheckAbility("manage", "crm:email-templates")
  async updateEmailTemplate(
    @Param("templateId", ParseIntPipe) templateId: number,
    @Body(new ZodValidationPipe(emailTemplateUpdateSchema)) body: EmailTemplateUpdateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const updated = await this.rules.updateEmailTemplate(u.orgId, templateId, body);
    if (!updated) throw new NotFoundException("Template not found");
    return updated;
  }

  @Delete("email-templates/:templateId")
  @UseGuards(AbilityGuard)
  @CheckAbility("manage", "crm:email-templates")
  deleteEmailTemplate(
    @Param("templateId", ParseIntPipe) templateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.rules.deleteEmailTemplate(u.orgId, templateId);
  }
}
