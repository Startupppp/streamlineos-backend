import {
  Body,
  Controller,
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
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { TrainingService } from "./training.service";
import {
  createTrainingProgramSchema,
  updateTrainingProgramSchema,
  markAttendanceSchema,
  type CreateTrainingProgramInput,
  type UpdateTrainingProgramInput,
  type MarkAttendanceInput,
} from "./dto/training.schemas";

@RequireModule("hr")
@Controller("hr/training")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class TrainingController {
  constructor(private readonly trainingService: TrainingService) {}

  @Get()
  @RequirePermission("hr:learning:view")
  listPrograms(@CurrentUser() u: CurrentUserContext) {
    return this.trainingService.listPrograms(u.orgId);
  }

  @Post()
  @RequirePermission("hr:learning:manage")
  @HttpCode(201)
  createProgram(
    @Body(new ZodValidationPipe(createTrainingProgramSchema)) body: CreateTrainingProgramInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.trainingService.createProgram(u.orgId, body);
  }

  @Patch(":programId")
  @RequirePermission("hr:learning:manage")
  updateProgram(
    @Param("programId", ParseIntPipe) programId: number,
    @Body(new ZodValidationPipe(updateTrainingProgramSchema)) body: UpdateTrainingProgramInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.trainingService.updateProgram(u.orgId, programId, body);
  }

  @Post(":programId/enroll")
  @HttpCode(201)
  @RequirePermission("hr:learning:view")
  enrollUser(
    @Param("programId", ParseIntPipe) programId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.trainingService.enrollUser(u.orgId, programId, u.userId);
  }

  @Get(":programId/attendance")
  @RequirePermission("hr:learning:manage")
  listAttendance(@Param("programId", ParseIntPipe) programId: number, @CurrentUser() u: CurrentUserContext) {
    return this.trainingService.listAttendance(u.orgId, programId);
  }

  @Patch(":programId/attendance/:userId")
  @RequirePermission("hr:learning:manage")
  markAttendance(
    @Param("programId", ParseIntPipe) programId: number,
    @Param("userId") userId: string,
    @Body(new ZodValidationPipe(markAttendanceSchema)) body: MarkAttendanceInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.trainingService.markAttendance(u.orgId, programId, userId, body);
  }
}
