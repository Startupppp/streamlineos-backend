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
import { TrainingService } from "./training.service";

interface CreateProgramBody {
  name: string;
  description?: string;
  type?: string;
  format?: string;
  startDate: string;
  endDate?: string;
  venue?: string;
  virtualLink?: string;
  maxCapacity?: number;
  instructorId?: string;
  externalInstructor?: string;
  isMandatory?: boolean;
  status?: string;
}

interface UpdateProgramBody {
  name?: string;
  description?: string;
  type?: string;
  format?: string;
  startDate?: string;
  endDate?: string;
  venue?: string;
  virtualLink?: string;
  maxCapacity?: number;
  instructorId?: string;
  externalInstructor?: string;
  isMandatory?: boolean;
  status?: string;
}

interface MarkAttendanceBody {
  status?: string;
  feedbackRating?: number;
  feedbackText?: string;
  certificateUrl?: string;
}

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
    @Body() body: CreateProgramBody,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.trainingService.createProgram(u.orgId, body);
  }

  @Patch(":programId")
  @RequirePermission("hr:learning:manage")
  updateProgram(
    @Param("programId", ParseIntPipe) programId: number,
    @Body() body: UpdateProgramBody,
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
    return this.trainingService.enrollUser(programId, u.userId);
  }

  @Get(":programId/attendance")
  @RequirePermission("hr:learning:manage")
  listAttendance(@Param("programId", ParseIntPipe) programId: number) {
    return this.trainingService.listAttendance(programId);
  }

  @Patch(":programId/attendance/:userId")
  @RequirePermission("hr:learning:manage")
  markAttendance(
    @Param("programId", ParseIntPipe) programId: number,
    @Param("userId") userId: string,
    @Body() body: MarkAttendanceBody,
  ) {
    return this.trainingService.markAttendance(programId, userId, body);
  }
}
