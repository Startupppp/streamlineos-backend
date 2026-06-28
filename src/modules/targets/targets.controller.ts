import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
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
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { TargetsService, isForbidden, isNotFound } from "./targets.service";
import {
  createSchema,
  leaderboardSchema,
  listSchema,
  updateSchema,
  type CreateInput,
  type LeaderboardInput,
  type ListInput,
  type UpdateInput,
} from "./dto/target.schemas";

@Controller("targets")
@UseGuards(JwtAuthGuard)
export class TargetsController {
  constructor(private readonly targets: TargetsService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(listSchema)) filters: ListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.targets.list(u.orgId, filters);
  }

  @Post()
  @HttpCode(201)
  async create(
    @Body(new ZodValidationPipe(createSchema)) body: CreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.targets.create(
      u.orgId,
      {
        role: u.role,
        callerId: u.userId,
        permissions: u.permissions,
        isOrgOwner: u.isOrgOwner,
        isPlatformAdmin: u.isPlatformAdmin,
      },
      body,
    );
    if (isForbidden(result)) {
      if (result.status === 400) throw new BadRequestException(result.message);
      throw new ForbiddenException(result.message);
    }
    return result;
  }

  @Get("my")
  myTargets(@CurrentUser() u: CurrentUserContext) {
    return this.targets.getMyTargets(u.orgId, u.userId);
  }

  @Get("leaderboard")
  leaderboard(
    @Query(new ZodValidationPipe(leaderboardSchema)) query: LeaderboardInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.targets.getLeaderboard(u.orgId, query.metricType);
  }

  @Get(":targetId/history")
  history(
    @Param("targetId", ParseIntPipe) targetId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.targets.getHistory(u.orgId, targetId);
  }

  @Patch(":targetId")
  async update(
    @Param("targetId", ParseIntPipe) targetId: number,
    @Body(new ZodValidationPipe(updateSchema)) body: UpdateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.targets.update(
      u.orgId,
      {
        role: u.role,
        callerId: u.userId,
        branchId: u.branchId,
        permissions: u.permissions,
        isOrgOwner: u.isOrgOwner,
        isPlatformAdmin: u.isPlatformAdmin,
      },
      targetId,
      body,
    );
    if (isNotFound(result)) throw new NotFoundException("Target not found");
    if (isForbidden(result)) throw new ForbiddenException(result.message);
    return result;
  }

  @Delete(":targetId")
  async remove(
    @Param("targetId", ParseIntPipe) targetId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.targets.remove(
      u.orgId,
      {
        role: u.role,
        callerId: u.userId,
        branchId: u.branchId,
        permissions: u.permissions,
        isOrgOwner: u.isOrgOwner,
        isPlatformAdmin: u.isPlatformAdmin,
      },
      targetId,
    );
    if (isNotFound(result)) throw new NotFoundException("Target not found");
    if (isForbidden(result)) throw new ForbiddenException(result.message);
    return result;
  }
}
