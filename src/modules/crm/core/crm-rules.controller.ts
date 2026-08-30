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
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { CrmRulesService } from "./crm-rules.service";
import {
  assignmentPreviewSchema,
  assignmentReorderSchema,
  assignmentRuleCreateSchema,
  assignmentRuleUpdateSchema,
  emailTemplateCreateSchema,
  emailTemplateUpdateSchema,
  scoringRuleCreateSchema,
  scoringRuleUpdateSchema,
  type AssignmentPreviewInput,
  type AssignmentReorderInput,
  type AssignmentRuleCreateInput,
  type AssignmentRuleUpdateInput,
  type EmailTemplateCreateInput,
  type EmailTemplateUpdateInput,
  type ScoringRuleCreateInput,
  type ScoringRuleUpdateInput,
} from "./dto/rules.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const ruleIdParams = z.object({ ruleId: z.coerce.number().int().positive() }).strict();
const templateIdParams = z.object({ templateId: z.coerce.number().int().positive() }).strict();

@RequireModule("crm")
@Controller("crm")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class CrmRulesController {
  constructor(private readonly rules: CrmRulesService) {}

  @Get("assignment-rules")
  @RequirePermission("crm:assignment-rules:manage")
  listAssignmentRules(@CurrentUser() u: CurrentUserContext) {
    return this.rules.listAssignmentRules(u.orgId);
  }

  @Post("assignment-rules/preview")
  @RequirePermission("crm:assignment-rules:manage")
  previewAssignment(
    @Body(new ZodValidationPipe(assignmentPreviewSchema)) body: AssignmentPreviewInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.rules.preview(u.orgId, body.sampleLead);
  }

  @Post("assignment-rules")
  @RequirePermission("crm:assignment-rules:manage")
  @HttpCode(201)
  createAssignmentRule(
    @Body(new ZodValidationPipe(assignmentRuleCreateSchema)) body: AssignmentRuleCreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.rules.createAssignmentRule(u.orgId, body);
  }

  @Patch("assignment-rules/reorder")
  @RequirePermission("crm:assignment-rules:manage")
  reorderAssignmentRules(
    @Body(new ZodValidationPipe(assignmentReorderSchema)) body: AssignmentReorderInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.rules.reorderAssignmentRules(u.orgId, body.ruleIds);
  }

  @Patch("assignment-rules/:ruleId")
  @RequirePermission("crm:assignment-rules:manage")
  @Validate({ params: ruleIdParams })
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
  @HttpCode(204)
  @RequirePermission("crm:assignment-rules:manage")
  @Validate({ params: ruleIdParams })
  async deleteAssignmentRule(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.rules.deleteAssignmentRule(u.orgId, ruleId);
  }

  @Get("scoring-rules")
  @RequirePermission("crm:scoring-rules:manage")
  listScoringRules(@CurrentUser() u: CurrentUserContext) {
    return this.rules.listScoringRules(u.orgId);
  }

  @Post("scoring-rules")
  @RequirePermission("crm:scoring-rules:manage")
  @HttpCode(201)
  createScoringRule(
    @Body(new ZodValidationPipe(scoringRuleCreateSchema)) body: ScoringRuleCreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.rules.createScoringRule(u.orgId, body);
  }

  @Patch("scoring-rules/:ruleId")
  @RequirePermission("crm:scoring-rules:manage")
  @Validate({ params: ruleIdParams })
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
  @HttpCode(204)
  @RequirePermission("crm:scoring-rules:manage")
  @Validate({ params: ruleIdParams })
  async deleteScoringRule(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.rules.deleteScoringRule(u.orgId, ruleId);
  }

  @Get("email-templates")
  @RequirePermission("crm:email-templates:manage")
  listEmailTemplates(@CurrentUser() u: CurrentUserContext) {
    return this.rules.listEmailTemplates(u.orgId);
  }

  @Post("email-templates")
  @RequirePermission("crm:email-templates:manage")
  @HttpCode(201)
  createEmailTemplate(
    @Body(new ZodValidationPipe(emailTemplateCreateSchema)) body: EmailTemplateCreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.rules.createEmailTemplate(u.orgId, u.userId, body);
  }

  @Patch("email-templates/:templateId")
  @RequirePermission("crm:email-templates:manage")
  @Validate({ params: templateIdParams })
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
  @HttpCode(204)
  @RequirePermission("crm:email-templates:manage")
  @Validate({ params: templateIdParams })
  async deleteEmailTemplate(
    @Param("templateId", ParseIntPipe) templateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.rules.deleteEmailTemplate(u.orgId, templateId);
  }
}
