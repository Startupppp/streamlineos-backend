import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { HrPeopleService } from "./hr-people.service";
import {
  createPersonSchema,
  paginationSchema,
  updatePersonSchema,
  type CreatePersonInput,
  type UpdatePersonInput,
} from "./dto/hr-core.schemas";
import { z } from "zod";

const listPeopleSchema = paginationSchema.extend({
  search: z.string().optional(),
});

@RequireModule("hr")
@Controller("hr/people")
@UseGuards(JwtAuthGuard)
export class HrPeopleController {
  constructor(private readonly people: HrPeopleService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:read")
  list(
    @Query(new ZodValidationPipe(listPeopleSchema)) query: z.infer<typeof listPeopleSchema>,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.people.list(u.orgId, { page: query.page, limit: query.limit, search: query.search });
  }

  @Get(":personId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:read")
  getOne(
    @Param("personId", ParseIntPipe) personId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.people.getOne(u.orgId, personId);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:manage")
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createPersonSchema)) body: CreatePersonInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.people.create(u.orgId, u.userId, body);
  }

  @Patch(":personId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:manage")
  update(
    @Param("personId", ParseIntPipe) personId: number,
    @Body(new ZodValidationPipe(updatePersonSchema)) body: UpdatePersonInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.people.update(u.orgId, personId, u.userId, body);
  }

  @Delete(":personId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:manage")
  remove(
    @Param("personId", ParseIntPipe) personId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.people.remove(u.orgId, personId, u.userId);
  }
}
