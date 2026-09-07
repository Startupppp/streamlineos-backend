import {
  Controller,
  Get,
  HttpCode,
  Post,
  Patch,
  Body,
  Param,
  ParseIntPipe,
  Query,
  UseGuards,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AccessService } from "../../access/access.service";
import { resolvePayrollRunsViewScope } from "../payroll-scope";
import { ProfilesService } from "./profiles.service";
import {
  listProfilesQuerySchema,
  createProfileSchema,
  patchProfileSchema,
  type ListProfilesQuery,
  type CreateProfileInput,
  type PatchProfileInput,
} from "./dto/runs.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { successSchema } from "../../../common/openapi/response-envelopes";
import {
  profileListResponseSchema,
  profileDetailResponseSchema,
  profileCreateResponseSchema,
  profileHistoryResponseSchema,
} from "./dto/profiles-response.schemas";
import { z } from "zod";

const employeeUserIdParams = z.object({ employeeUserId: z.string().min(1) }).strict();
const employeeUserIdprofileIdParams = z.object({ employeeUserId: z.string().min(1), profileId: z.coerce.number().int().positive() }).strict();

@RequireModule("payroll")
@Controller("payroll/employees")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class ProfilesController {
  constructor(
    private readonly profilesService: ProfilesService,
    private readonly access: AccessService,
  ) {}

  @Get()
  @RequirePermission("payroll:salaries:view")
  @Validate({ query: listProfilesQuerySchema })
  @ResponseSchema(profileListResponseSchema)
  async list(
    @Query() query: ListProfilesQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const scope = await resolvePayrollRunsViewScope(this.access, u);
    return this.profilesService.listProfiles(u.orgId, query, scope, u.userId);
  }

  @Get(":employeeUserId")
  @RequirePermission("payroll:salaries:view")
  @Validate({ params: employeeUserIdParams })
  @ResponseSchema(profileDetailResponseSchema)
  async getOne(
    @Param("employeeUserId") employeeUserId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.profilesService.getProfile(u.orgId, employeeUserId);
    if (!result) throw new NotFoundException("No active salary profile found for this employee");
    return result;
  }

  @Post(":employeeUserId/profiles")
  @HttpCode(201)
  @RequirePermission("payroll:salaries:update")
  @Validate({ params: employeeUserIdParams, body: createProfileSchema })
  @ResponseSchema(profileCreateResponseSchema)
  async createProfile(
    @Param("employeeUserId") employeeUserId: string,
    @Body() body: CreateProfileInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.profilesService.createProfile(u.orgId, employeeUserId, u.userId, body);
  }

  @Patch(":employeeUserId/profiles/:profileId")
  @RequirePermission("payroll:salaries:update")
  @Validate({ params: employeeUserIdprofileIdParams, body: patchProfileSchema })
  @ResponseSchema(successSchema)
  async patchProfile(
    @Param("employeeUserId") employeeUserId: string,
    @Param("profileId", ParseIntPipe) profileId: number,
    @Body() body: PatchProfileInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.profilesService.patchProfile(u.orgId, employeeUserId, profileId, body, u.userId);
    if (!result) throw new NotFoundException("Salary profile not found");
    if (!result.ok) throw new BadRequestException("Cannot update a superseded salary profile");
    return { ok: true };
  }

  @Get(":employeeUserId/history")
  @RequirePermission("payroll:salaries:view")
  @Validate({ params: employeeUserIdParams })
  @ResponseSchema(profileHistoryResponseSchema)
  async getHistory(
    @Param("employeeUserId") employeeUserId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.profilesService.listHistory(u.orgId, employeeUserId);
  }
}
