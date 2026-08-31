import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AlumniService } from "./alumni.service";
import {
  alumniListSchema,
  alumniCreateSchema,
  type AlumniListInput,
  type AlumniCreateInput,
} from "./dto/hr-lifecycle.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Validate } from "../../../common/validation/validate.decorator";

@RequireModule("hr")
@Controller("hr/alumni")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class AlumniController {
  constructor(private readonly alumni: AlumniService) {}

  @Get()
  @RequirePermission("hr:alumni:read")
  @Validate({ query: alumniListSchema })
  list(
    @Query() query: AlumniListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.alumni.list(u.orgId, query.limit);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:alumni:write")
  @HttpCode(201)
  @Validate({ body: alumniCreateSchema })
  create(
    @Body() body: AlumniCreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.alumni.create(u.orgId, body);
  }
}
