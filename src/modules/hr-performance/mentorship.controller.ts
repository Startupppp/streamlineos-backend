import { Controller, Get, HttpCode, Post, Patch, Body, Param, ParseIntPipe, UseGuards } from "@nestjs/common";
import { MentorshipService } from "./mentorship.service";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import {
  createMentorshipSchema,
  updateMentorshipSchema,
  type CreateMentorshipInput,
  type UpdateMentorshipInput,
} from "./dto/mentorship.schemas";

@RequireModule("hr")
@Controller("hr/mentorships")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class MentorshipController {
  constructor(private readonly mentorshipService: MentorshipService) {}

  @Get()
  @RequirePermission("hr:learning:view")
  list(@CurrentUser() user: CurrentUserContext) {
    const isManager = user.isOrgOwner || user.isPlatformAdmin;
    return this.mentorshipService.list(user.orgId, user.userId, isManager);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("hr:learning:manage")
  create(
    @CurrentUser() user: CurrentUserContext,
    @Body(new ZodValidationPipe(createMentorshipSchema)) body: CreateMentorshipInput,
  ) {
    return this.mentorshipService.create(user.orgId, body);
  }

  @Patch(":mentorshipId")
  @RequirePermission("hr:learning:manage")
  update(
    @CurrentUser() user: CurrentUserContext,
    @Param("mentorshipId", ParseIntPipe) mentorshipId: number,
    @Body(new ZodValidationPipe(updateMentorshipSchema)) body: UpdateMentorshipInput,
  ) {
    return this.mentorshipService.update(user.orgId, mentorshipId, body);
  }
}
