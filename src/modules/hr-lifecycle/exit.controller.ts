import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { ExitService } from "./exit.service";
import { ExitWriteService } from "./exit-write.service";
import {
  experienceLetterSchema,
  resignationCreateSchema,
  resignationUpdateSchema,
  resignationCeoReviewSchema,
  resignationHrReviewSchema,
  type ExperienceLetterInput,
  type ResignationCreateInput,
  type ResignationUpdateInput,
  type ResignationCeoReviewInput,
  type ResignationHrReviewInput,
} from "./dto/hr-lifecycle.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";

@RequireModule("hr")
@Controller("hr/exit")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ExitController {
  constructor(
    private readonly exit: ExitService,
    private readonly exitWrite: ExitWriteService,
  ) {}

  @Get()
  @RequirePermission("hr:exit:view")
  list(@CurrentUser() u: CurrentUserContext) {
    const isAdmin = u.isOrgOwner || u.isPlatformAdmin || u.permissions.includes("hr:exit:manage");
    return this.exit.list(u.orgId, u.userId, isAdmin);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("hr:exit:create")
  create(
    @Body(new ZodValidationPipe(resignationCreateSchema)) body: ResignationCreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (u.isOrgOwner || u.isPlatformAdmin) {
      throw new ForbiddenException("CEO users cannot submit a resignation through this system.");
    }
    return this.exitWrite.create(u.orgId, u.userId, body);
  }

  @Patch(":resignationId/hr-review")
  @RequirePermission("hr:exit:manage")
  hrReview(
    @Param("resignationId", ParseIntPipe) resignationId: number,
    @Body(new ZodValidationPipe(resignationHrReviewSchema)) body: ResignationHrReviewInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.exitWrite.hrReview(u.orgId, u.userId, resignationId, body);
  }

  @Patch(":resignationId/ceo-review")
  @RequirePermission("hr:exit:approve")
  ceoReview(
    @Param("resignationId", ParseIntPipe) resignationId: number,
    @Body(new ZodValidationPipe(resignationCeoReviewSchema)) body: ResignationCeoReviewInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.exitWrite.ceoReview(u.orgId, u.userId, resignationId, body);
  }

  @Patch(":resignationId")
  @RequirePermission("hr:exit:view")
  update(
    @Param("resignationId", ParseIntPipe) resignationId: number,
    @Body(new ZodValidationPipe(resignationUpdateSchema)) body: ResignationUpdateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const isApprover = u.isOrgOwner || u.isPlatformAdmin || u.permissions.includes("hr:exit:manage");
    return this.exitWrite.update(
      u.orgId,
      { userId: u.userId, role: u.role, isApprover },
      resignationId,
      body,
    );
  }

  @Get("analytics")
  @RequirePermission("hr:exit:manage")
  getAnalytics(@CurrentUser() u: CurrentUserContext) {
    return this.exit.getAnalytics(u.orgId);
  }

  @Post("experience-letter")
  @HttpCode(201)
  @RequirePermission("hr:exit:manage")
  createExperienceLetter(
    @Body(new ZodValidationPipe(experienceLetterSchema)) body: ExperienceLetterInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.exit.createExperienceLetter(u.orgId, u.userId, body);
  }

  @Get(":resignationId/letter")
  @RequirePermission("hr:exit:view")
  getLetter(
    @Param("resignationId", ParseIntPipe) resignationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const isAdmin = u.isOrgOwner || u.isPlatformAdmin || u.permissions.includes("hr:exit:manage");
    return this.exit.getLetter(u.orgId, u.userId, isAdmin, resignationId);
  }

  @Get(":resignationId/progress")
  @RequirePermission("hr:exit:view")
  getProgress(
    @Param("resignationId", ParseIntPipe) resignationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const isAdmin = u.isOrgOwner || u.isPlatformAdmin || u.permissions.includes("hr:exit:manage");
    return this.exit.getProgress(u.orgId, u.userId, isAdmin, resignationId);
  }

  @Patch(":resignationId/withdraw")
  @RequirePermission("hr:exit:view")
  withdraw(
    @Param("resignationId", ParseIntPipe) resignationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const isAdmin = u.isOrgOwner || u.isPlatformAdmin || u.permissions.includes("hr:exit:manage");
    return this.exit.withdraw(u.orgId, u.userId, isAdmin, resignationId);
  }

  @Get(":resignationId")
  @RequirePermission("hr:exit:view")
  getDetail(
    @Param("resignationId", ParseIntPipe) resignationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const isAdmin = u.isOrgOwner || u.isPlatformAdmin || u.permissions.includes("hr:exit:manage");
    return this.exit.getDetail(u.orgId, u.userId, isAdmin, resignationId);
  }
}
