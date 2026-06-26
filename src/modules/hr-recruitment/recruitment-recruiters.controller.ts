import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { RecruitmentRecruitersService } from "./recruitment-recruiters.service";
import { RECRUITMENT_ADMIN_ROLES, RECRUITMENT_MANAGER_ROLES } from "./recruitment-roles";
import {
  recruiterActivityQuerySchema,
  recruiterActivitySchema,
  upsertPortalSchema,
  type RecruiterActivityInput,
  type RecruiterActivityQueryInput,
  type UpsertPortalInput,
} from "./dto/jobs.schemas";

@Controller("hr/recruitment")
@UseGuards(JwtAuthGuard)
export class RecruitmentRecruitersController {
  constructor(private readonly recruiters: RecruitmentRecruitersService) {}

  @Get("portals")
  listPortals(@CurrentUser() u: CurrentUserContext) {
    if (!RECRUITMENT_MANAGER_ROLES.includes(u.role)) throw new ForbiddenException("Forbidden");
    return this.recruiters.listPortals(u.orgId);
  }

  @Post("portals")
  async upsertPortal(
    @Body(new ZodValidationPipe(upsertPortalSchema)) body: UpsertPortalInput,
    @CurrentUser() u: CurrentUserContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!RECRUITMENT_ADMIN_ROLES.includes(u.role)) throw new ForbiddenException("Forbidden: Admin role required");
    const { record, created } = await this.recruiters.upsertPortal(u.orgId, u.userId, body);
    res.status(created ? 201 : 200);
    return record;
  }

  @Post("portals/:platform/sync")
  syncPortal(
    @Param("platform") platform: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!RECRUITMENT_ADMIN_ROLES.includes(u.role)) throw new ForbiddenException("Forbidden");
    return this.recruiters.syncPortal(u.orgId, platform);
  }

  @Get("recruiters")
  recruiterDirectory(@CurrentUser() u: CurrentUserContext) {
    return this.recruiters.recruiterDirectory(u.orgId);
  }

  @Get("recruiters/activity")
  listActivity(
    @Query(new ZodValidationPipe(recruiterActivityQuerySchema)) query: RecruiterActivityQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.recruiters.listActivity(u.orgId, query);
  }

  @Post("recruiters/activity")
  @HttpCode(201)
  logActivity(
    @Body(new ZodValidationPipe(recruiterActivitySchema)) body: RecruiterActivityInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.recruiters.logActivity(u.orgId, u.userId, body);
  }
}
