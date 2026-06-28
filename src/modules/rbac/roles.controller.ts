import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { RolesService } from "./roles.service";
import {
  cloneTemplateSchema,
  createRoleSchema,
  updateRoleSchema,
  type CloneTemplateInput,
  type CreateRoleInput,
  type UpdateRoleInput,
} from "./dto/rbac.schemas";

@Controller("roles")
@UseGuards(JwtAuthGuard)
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  list(@CurrentUser() u: CurrentUserContext) {
    return this.roles.getRoles(u.orgId);
  }

  @Post()
  create(
    @Body(new ZodValidationPipe(createRoleSchema)) body: CreateRoleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.roles.createRole(u, body);
  }

  @Get("templates")
  templates() {
    return this.roles.listTemplates();
  }

  @Post("templates")
  cloneTemplate(
    @Body(new ZodValidationPipe(cloneTemplateSchema)) body: CloneTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.roles.cloneTemplate(u, body);
  }

  @Get("simulate/:targetUserId")
  simulate(@Param("targetUserId") targetUserId: string, @CurrentUser() u: CurrentUserContext) {
    return this.roles.simulatePermissions(u, targetUserId);
  }

  @Get(":roleId")
  get(@Param("roleId") roleId: string, @CurrentUser() u: CurrentUserContext) {
    return this.roles.getRole(u.orgId, this.parseRoleId(roleId));
  }

  @Patch(":roleId")
  update(
    @Param("roleId") roleId: string,
    @Body(new ZodValidationPipe(updateRoleSchema)) body: UpdateRoleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.roles.updateRole(u, this.parseRoleId(roleId), body);
  }

  @Delete(":roleId")
  remove(@Param("roleId") roleId: string, @CurrentUser() u: CurrentUserContext) {
    return this.roles.deleteRole(u, this.parseRoleId(roleId));
  }

  private parseRoleId(raw: string): number {
    const roleId = Number(raw);
    if (!Number.isFinite(roleId)) throw new BadRequestException("Invalid ID");
    return roleId;
  }
}
