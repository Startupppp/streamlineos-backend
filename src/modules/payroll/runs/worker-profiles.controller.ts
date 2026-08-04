import {
  Controller,
  Get,
  HttpCode,
  Post,
  Patch,
  Body,
  Param,
  ParseIntPipe,
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
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { ProfilesService } from "./profiles.service";
import {
  createProfileSchema,
  patchProfileSchema,
  type CreateProfileInput,
  type PatchProfileInput,
} from "./dto/runs.schemas";

@RequireModule("payroll")
@Controller("payroll/workers")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class WorkerProfilesController {
  constructor(private readonly profilesService: ProfilesService) {}

  @Get(":workerId")
  @RequirePermission("payroll:salaries:view")
  async getOne(@Param("workerId") workerId: string, @CurrentUser() u: CurrentUserContext) {
    const result = await this.profilesService.getProfileByWorker(u.orgId, workerId);
    if (!result.active && result.history.length === 0) {
      throw new NotFoundException("No salary profile found for this worker");
    }
    return result;
  }

  @Post(":workerId/profiles")
  @HttpCode(201)
  @RequirePermission("payroll:salaries:update")
  async createProfile(
    @Param("workerId") workerId: string,
    @Body(new ZodValidationPipe(createProfileSchema)) body: CreateProfileInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.profilesService.createProfileByWorker(u.orgId, workerId, u.userId, body);
  }

  @Patch(":workerId/profiles/:profileId")
  @RequirePermission("payroll:salaries:update")
  async patchProfile(
    @Param("workerId") workerId: string,
    @Param("profileId", ParseIntPipe) profileId: number,
    @Body(new ZodValidationPipe(patchProfileSchema)) body: PatchProfileInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.profilesService.patchProfileByWorker(
      u.orgId,
      workerId,
      profileId,
      body,
      u.userId,
    );
    if (!result) throw new NotFoundException("Salary profile not found");
    if (!result.ok) throw new BadRequestException("Cannot update a superseded salary profile");
    return { ok: true };
  }

  @Get(":workerId/history")
  @RequirePermission("payroll:salaries:view")
  async getHistory(@Param("workerId") workerId: string, @CurrentUser() u: CurrentUserContext) {
    return this.profilesService.listHistoryByWorker(u.orgId, workerId);
  }
}
