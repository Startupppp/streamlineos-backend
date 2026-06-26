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
import { userCan } from "./ability.helper";
import { experienceLetterSchema, type ExperienceLetterInput } from "./dto/hr-lifecycle.schemas";

@Controller("hr/exit")
@UseGuards(JwtAuthGuard)
export class ExitController {
  constructor(private readonly exit: ExitService) {}

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
}
