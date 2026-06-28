import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { AlumniService } from "./alumni.service";
import {
  alumniListSchema,
  alumniCreateSchema,
  type AlumniListInput,
  type AlumniCreateInput,
} from "./dto/hr-lifecycle.schemas";

@Controller("hr/alumni")
@UseGuards(JwtAuthGuard)
export class AlumniController {
  constructor(private readonly alumni: AlumniService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(alumniListSchema)) query: AlumniListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.alumni.list(u.orgId, query.limit);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:alumni:write")
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(alumniCreateSchema)) body: AlumniCreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.alumni.create(u.orgId, body);
  }
}
