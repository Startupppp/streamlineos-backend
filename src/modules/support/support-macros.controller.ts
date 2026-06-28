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
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { SupportMacrosService } from "./support-macros.service";
import {
  createMacroSchema,
  createRoutingRuleSchema,
  listMacrosSchema,
  updateMacroSchema,
  updateRoutingRuleSchema,
  type CreateMacroInput,
  type CreateRoutingRuleInput,
  type ListMacrosInput,
  type UpdateMacroInput,
  type UpdateRoutingRuleInput,
} from "./dto/support.schemas";

@Controller("support")
@UseGuards(JwtAuthGuard)
export class SupportMacrosController {
  constructor(private readonly macros: SupportMacrosService) {}

  @Get("macros")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:macros:view")
  listMacros(
    @Query(new ZodValidationPipe(listMacrosSchema)) query: ListMacrosInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.macros.listMacros(u.orgId, query);
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
  deleteMacro(
    @Param("macroId", ParseIntPipe) macroId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.macros.deleteMacro(u.orgId, macroId);
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
  createRoutingRule(
    @Body(new ZodValidationPipe(createRoutingRuleSchema)) body: CreateRoutingRuleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.macros.createRoutingRule(u.orgId, u.userId, body);
  }

  @Patch("routing-rules/:ruleId")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:macros:manage")
  updateRoutingRule(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @Body(new ZodValidationPipe(updateRoutingRuleSchema)) body: UpdateRoutingRuleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.macros.updateRoutingRule(u.orgId, ruleId, body);
  }

  @Delete("routing-rules/:ruleId")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:macros:manage")
  deleteRoutingRule(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.macros.deleteRoutingRule(u.orgId, ruleId);
  }
}
