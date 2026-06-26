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
import { hasRoleOrPrivileged } from "../../common/auth/role-access";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { TerminationService } from "./termination.service";
import { userCan } from "./ability.helper";
import {
  terminationCreateSchema,
  terminationReviewSchema,
  type TerminationCreateInput,
  type TerminationReviewInput,
} from "./dto/hr-lifecycle.schemas";

@Controller("hr/termination")
@UseGuards(JwtAuthGuard)
export class TerminationController {
  constructor(private readonly termination: TerminationService) {}

  private assertManageAccess(u: CurrentUserContext): void {
    if (!hasRoleOrPrivileged(u, ["HR", "CEO"]) && !userCan(u, "manage", "hr:employees")) {
      throw new ForbiddenException("Forbidden");
    }
  }

  @Get()
  list(@CurrentUser() u: CurrentUserContext) {
    this.assertManageAccess(u);
    return this.termination.list(u.orgId);
  }

  @Post()
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(terminationCreateSchema)) body: TerminationCreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!hasRoleOrPrivileged(u, ["HR", "CEO"])) {
      throw new ForbiddenException("Only HR or CEO can initiate terminations.");
    }
    return this.termination.create(u.orgId, u.userId, u.role, body);
  }

  @Get(":terminationId/letter")
  getLetter(
    @Param("terminationId", ParseIntPipe) terminationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    this.assertManageAccess(u);
    return this.termination.getLetter(u.orgId, terminationId);
  }

  @Patch(":terminationId/submit")
  submit(
    @Param("terminationId", ParseIntPipe) terminationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!hasRoleOrPrivileged(u, ["HR", "CEO"])) {
      throw new ForbiddenException("Only HR can submit for CEO approval.");
    }
    return this.termination.submit(u.orgId, u.userId, terminationId);
  }

  @Patch(":terminationId/ceo-review")
  ceoReview(
    @Param("terminationId", ParseIntPipe) terminationId: number,
    @Body(new ZodValidationPipe(terminationReviewSchema)) body: TerminationReviewInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!hasRoleOrPrivileged(u, ["CEO"])) {
      throw new ForbiddenException("Only CEO can review terminations.");
    }
    return this.termination.ceoReview(u.orgId, u.userId, terminationId, body);
  }

  @Get(":terminationId")
  getOne(
    @Param("terminationId", ParseIntPipe) terminationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    this.assertManageAccess(u);
    return this.termination.getOne(u.orgId, terminationId);
  }
}
