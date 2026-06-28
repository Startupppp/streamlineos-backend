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
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { ExitService } from "./exit.service";
import { ExitWriteService } from "./exit-write.service";
import { userCan } from "./ability.helper";
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

@Controller("hr/exit")
@UseGuards(JwtAuthGuard)
export class ExitController {
  constructor(
    private readonly exit: ExitService,
    private readonly exitWrite: ExitWriteService,
  ) {}

  @Get()
  list(@CurrentUser() u: CurrentUserContext) {
    return this.exit.list(u.orgId, u.userId, userCan(u, "approve", "hr:leaves"));
  }

  @Post()
  @HttpCode(201)
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
  hrReview(
    @Param("resignationId", ParseIntPipe) resignationId: number,
    @Body(new ZodValidationPipe(resignationHrReviewSchema)) body: ResignationHrReviewInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!userCan(u, "manage", "hr:exit")) throw new ForbiddenException("Forbidden");
    if (u.role !== "HR" && u.role !== "CEO") {
      throw new ForbiddenException("Only HR can perform HR review.");
    }
    return this.exitWrite.hrReview(u.orgId, u.userId, resignationId, body);
  }

  @Patch(":resignationId/ceo-review")
  ceoReview(
    @Param("resignationId", ParseIntPipe) resignationId: number,
    @Body(new ZodValidationPipe(resignationCeoReviewSchema)) body: ResignationCeoReviewInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (u.role !== "CEO") throw new ForbiddenException("Only CEO can perform CEO review.");
    return this.exitWrite.ceoReview(u.orgId, u.userId, resignationId, body);
  }

  @Patch(":resignationId")
  update(
    @Param("resignationId", ParseIntPipe) resignationId: number,
    @Body(new ZodValidationPipe(resignationUpdateSchema)) body: ResignationUpdateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.exitWrite.update(
      u.orgId,
      { userId: u.userId, role: u.role, isApprover: userCan(u, "approve", "hr:leaves") },
      resignationId,
      body,
    );
  }

  @Get("analytics")
  getAnalytics(@CurrentUser() u: CurrentUserContext) {
    if (!userCan(u, "approve", "hr:leaves")) throw new ForbiddenException("Forbidden");
    return this.exit.getAnalytics(u.orgId);
  }

  @Post("experience-letter")
  @HttpCode(201)
  createExperienceLetter(
    @Body(new ZodValidationPipe(experienceLetterSchema)) body: ExperienceLetterInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!userCan(u, "approve", "hr:leaves")) {
      throw new ForbiddenException("Only admins can generate experience letters.");
    }
    return this.exit.createExperienceLetter(u.orgId, u.userId, body);
  }

  @Get(":resignationId/letter")
  getLetter(
    @Param("resignationId", ParseIntPipe) resignationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.exit.getLetter(u.orgId, u.userId, userCan(u, "approve", "hr:leaves"), resignationId);
  }

  @Get(":resignationId/progress")
  getProgress(
    @Param("resignationId", ParseIntPipe) resignationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.exit.getProgress(u.orgId, u.userId, userCan(u, "approve", "hr:leaves"), resignationId);
  }

  @Patch(":resignationId/withdraw")
  withdraw(
    @Param("resignationId", ParseIntPipe) resignationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.exit.withdraw(u.orgId, u.userId, userCan(u, "approve", "hr:leaves"), resignationId);
  }

  @Get(":resignationId")
  getDetail(
    @Param("resignationId", ParseIntPipe) resignationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.exit.getDetail(u.orgId, u.userId, userCan(u, "approve", "hr:leaves"), resignationId);
  }
}
