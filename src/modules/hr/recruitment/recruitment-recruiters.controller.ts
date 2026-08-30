import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { RecruitmentRecruitersService } from "./recruitment-recruiters.service";
import {
  recruiterActivityQuerySchema,
  recruiterActivitySchema,
  upsertPortalSchema,
  type RecruiterActivityInput,
  type RecruiterActivityQueryInput,
  type UpsertPortalInput,
} from "./dto/jobs.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const platformParams = z.object({ platform: z.string().min(1) }).strict();

@RequireModule("hr")
@Controller("hr/recruitment")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class RecruitmentRecruitersController {
  constructor(private readonly recruiters: RecruitmentRecruitersService) {}

  @Get("portals")
  @RequirePermission("hr:employees:manage")
  listPortals(@CurrentUser() u: CurrentUserContext) {
    return this.recruiters.listPortals(u.orgId);
  }

  @Post("portals")
  @RequirePermission("hr:employees:manage")
  async upsertPortal(
    @Body(new ZodValidationPipe(upsertPortalSchema)) body: UpsertPortalInput,
    @CurrentUser() u: CurrentUserContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { record, created } = await this.recruiters.upsertPortal(u.orgId, u.userId, body);
    res.status(created ? 201 : 200);
    return record;
  }

  @Post("portals/:platform/sync")
  @RequirePermission("hr:employees:manage")
  @Validate({ params: platformParams })
  syncPortal(
    @Param("platform") platform: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.recruiters.syncPortal(u.orgId, platform);
  }

  @Get("recruiters")
  @RequirePermission("hr:employees:view")
  recruiterDirectory(@CurrentUser() u: CurrentUserContext) {
    return this.recruiters.recruiterDirectory(u.orgId);
  }

  @Get("recruiters/activity")
  @RequirePermission("hr:employees:view")
  listActivity(
    @Query(new ZodValidationPipe(recruiterActivityQuerySchema)) query: RecruiterActivityQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.recruiters.listActivity(u.orgId, query);
  }

  @Post("recruiters/activity")
  @HttpCode(201)
  @RequirePermission("hr:employees:view")
  logActivity(
    @Body(new ZodValidationPipe(recruiterActivitySchema)) body: RecruiterActivityInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.recruiters.logActivity(u.orgId, u.userId, body);
  }
}
