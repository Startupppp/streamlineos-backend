import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { SupportMacrosService } from "./support-macros.service";
import { SupportSettingsAuditService } from "./support-settings-audit.service";
import {
  applyMacroSchema,
  createMacroSchema,
  createRoutingRuleSchema,
  listMacrosSchema,
  updateMacroSchema,
  updateRoutingRuleSchema,
  setAgentSkillsSchema,
  setAgentAvailabilitySchema,
  addVipClientSchema,
  type ApplyMacroInput,
  type CreateMacroInput,
  type CreateRoutingRuleInput,
  type ListMacrosInput,
  type UpdateMacroInput,
  type UpdateRoutingRuleInput,
  type SetAgentSkillsInput,
  type SetAgentAvailabilityInput,
  type AddVipClientInput,
} from "./dto/support.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { z } from "zod";
import { Validate } from "../../../common/validation/validate.decorator";

const macroIdParams = z.object({ macroId: z.coerce.number().int().positive() }).strict();
const ruleIdParams = z.object({ ruleId: z.coerce.number().int().positive() }).strict();
const clientIdParams = z.object({ clientId: z.coerce.number().int().positive() }).strict();
const userIdStringParams = z.object({ userId: z.string().min(1) }).strict();

@RequireModule("support")
@Controller("support")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class SupportMacrosController {
  constructor(
    private readonly macros: SupportMacrosService,
    private readonly audit: SupportSettingsAuditService,
  ) {}

  @Get("macros")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:macros:view")
  listMacros(
    @Query(new ZodValidationPipe(listMacrosSchema)) query: ListMacrosInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.macros.listMacros(u.orgId, u.userId, query);
  }

  @Get("macros/usage")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:macros:view")
  getMacroUsage(@CurrentUser() u: CurrentUserContext) {
    return this.macros.getUsage(u.orgId);
  }

  @Post("macros")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:macros:manage")
  @HttpCode(201)
  createMacro(
    @Body(new ZodValidationPipe(createMacroSchema)) body: CreateMacroInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.macros.createMacro(u.orgId, u.userId, body);
  }

  @Patch("macros/:macroId")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:macros:manage")
  @Validate({ params: macroIdParams })
  updateMacro(
    @Param("macroId", ParseIntPipe) macroId: number,
    @Body(new ZodValidationPipe(updateMacroSchema)) body: UpdateMacroInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.macros.updateMacro(u.orgId, macroId, body);
  }

  @Delete("macros/:macroId")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:macros:manage")
  @Validate({ params: macroIdParams })
  deleteMacro(
    @Param("macroId", ParseIntPipe) macroId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.macros.deleteMacro(u.orgId, macroId);
  }

  @Post("macros/:macroId/preview")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:macros:view")
  @HttpCode(200)
  @Validate({ params: macroIdParams })
  previewMacro(
    @Param("macroId", ParseIntPipe) macroId: number,
    @Body(new ZodValidationPipe(applyMacroSchema)) body: ApplyMacroInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.macros.previewMacro(u.orgId, macroId, u.userId, body.ticketId);
  }

  @Post("macros/:macroId/apply")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:tickets:reply")
  @HttpCode(200)
  @Validate({ params: macroIdParams })
  applyMacro(
    @Param("macroId", ParseIntPipe) macroId: number,
    @Body(new ZodValidationPipe(applyMacroSchema)) body: ApplyMacroInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.macros.applyMacro(u.orgId, macroId, u.userId, body);
  }

  @Get("routing-rules")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:macros:view")
  listRoutingRules(@CurrentUser() u: CurrentUserContext) {
    return this.macros.listRoutingRules(u.orgId);
  }

  @Post("routing-rules")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:macros:manage")
  @HttpCode(201)
  async createRoutingRule(
    @Body(new ZodValidationPipe(createRoutingRuleSchema)) body: CreateRoutingRuleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.macros.createRoutingRule(u.orgId, u.userId, body);
    await this.audit.record(u.orgId, u.userId, "routing_rule", result.id, "created", body);
    return result;
  }

  @Patch("routing-rules/:ruleId")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:macros:manage")
  @Validate({ params: ruleIdParams })
  async updateRoutingRule(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @Body(new ZodValidationPipe(updateRoutingRuleSchema)) body: UpdateRoutingRuleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.macros.updateRoutingRule(u.orgId, ruleId, body);
    await this.audit.record(u.orgId, u.userId, "routing_rule", ruleId, "updated", body);
    return result;
  }

  @Delete("routing-rules/:ruleId")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:macros:manage")
  @Validate({ params: ruleIdParams })
  async deleteRoutingRule(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.macros.deleteRoutingRule(u.orgId, ruleId);
    await this.audit.record(u.orgId, u.userId, "routing_rule", ruleId, "deleted");
    return result;
  }

  @Get("agent-skills")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:macros:view")
  listAgentSkills(@CurrentUser() u: CurrentUserContext) {
    return this.macros.listAgentSkills(u.orgId);
  }

  @Put("agent-skills/:userId")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:macros:manage")
  @Validate({ params: userIdStringParams })
  async setAgentSkills(
    @Param("userId") userId: string,
    @Body(new ZodValidationPipe(setAgentSkillsSchema)) body: SetAgentSkillsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.macros.setAgentSkills(u.orgId, userId, body.skills);
    await this.audit.record(u.orgId, u.userId, "agent_skill", userId, "updated", body);
    return result;
  }

  @Get("agent-availability")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:macros:view")
  listAgentAvailability(@CurrentUser() u: CurrentUserContext) {
    return this.macros.listAgentAvailability(u.orgId);
  }

  @Put("agent-availability/me")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:tickets:reply")
  setMyAvailability(
    @Body(new ZodValidationPipe(setAgentAvailabilitySchema)) body: SetAgentAvailabilityInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.macros.setAgentAvailability(u.orgId, u.userId, body.isAvailable);
  }

  @Get("vip-clients")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:macros:view")
  listVipClients(@CurrentUser() u: CurrentUserContext) {
    return this.macros.listVipClients(u.orgId);
  }

  @Post("vip-clients")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:macros:manage")
  @HttpCode(201)
  async addVipClient(
    @Body(new ZodValidationPipe(addVipClientSchema)) body: AddVipClientInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.macros.addVipClient(u.orgId, body.clientId);
    await this.audit.record(u.orgId, u.userId, "vip_client", body.clientId, "created");
    return result;
  }

  @Delete("vip-clients/:clientId")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:macros:manage")
  @Validate({ params: clientIdParams })
  async removeVipClient(
    @Param("clientId", ParseIntPipe) clientId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.macros.removeVipClient(u.orgId, clientId);
    await this.audit.record(u.orgId, u.userId, "vip_client", clientId, "deleted");
    return result;
  }
}
