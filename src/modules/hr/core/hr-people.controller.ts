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
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

import { HrPeopleService } from "./hr-people.service";
import { HrEmployeeRecordListsService } from "./hr-employee-record-lists.service";
import { PersonEmploymentSyncService } from "./person-employment-sync.service";
import { AccessService } from "../../access/access.service";
import { resolveEmployeesScope } from "../directory/employees-scope";
import {
  createPersonSchema,
  listPeopleSchema,
  updatePersonSchema,
  type CreatePersonInput,
  type ListPeopleInput,
  type UpdatePersonInput,
} from "./dto/hr-core.schemas";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { UseRateLimit } from "../../../common/ratelimit/use-rate-limit.decorator";
import { RateLimitGuard } from "../../../common/ratelimit/rate-limit.guard";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const personIdParams = z.object({ personId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@Controller("hr/people")
@UseGuards(JwtAuthGuard)
export class HrPeopleController {
  constructor(
    private readonly people: HrPeopleService,
    private readonly employeeRecordLists: HrEmployeeRecordListsService,
    private readonly personEmploymentSync: PersonEmploymentSyncService,
    private readonly access: AccessService,
  ) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:view")
  async list(
    @Query(new ZodValidationPipe(listPeopleSchema)) query: ListPeopleInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    const scope = await resolveEmployeesScope(this.access, currentUser);
    if (query.page !== undefined) {
      return this.employeeRecordLists.listPeoplePage(
        currentUser.orgId,
        currentUser.userId,
        { page: query.page, limit: query.limit, search: query.search },
        scope,
      );
    }
    return this.employeeRecordLists.listPeopleCursor(
      currentUser.orgId,
      currentUser.userId,
      { cursor: query.cursor, limit: query.limit, search: query.search },
      scope,
    );
  }

  @Post("backfill-from-members")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:manage")
  @Idempotent("hr.people.backfill-from-members")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("hr:employee-backfill")
  @HttpCode(200)
  backfillFromMembers(@CurrentUser() currentUser: CurrentUserContext) {
    return this.personEmploymentSync.backfillOrg(
      currentUser.orgId,
      currentUser.userId,
    );
  }

  @Get(":personId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:view")
  @Validate({ params: personIdParams })
  async getOne(
    @Param("personId", ParseIntPipe) personId: number,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    const scope = await resolveEmployeesScope(this.access, currentUser);
    return this.people.getOne(
      currentUser.orgId,
      currentUser.userId,
      personId,
      scope,
    );
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:manage")
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createPersonSchema)) body: CreatePersonInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.people.create(currentUser.orgId, currentUser.userId, body);
  }

  @Patch(":personId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:manage")
  @Validate({ params: personIdParams })
  update(
    @Param("personId", ParseIntPipe) personId: number,
    @Body(new ZodValidationPipe(updatePersonSchema)) body: UpdatePersonInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.people.update(
      currentUser.orgId,
      personId,
      currentUser.userId,
      body,
    );
  }

  @Delete(":personId")
  @HttpCode(204)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:manage")
  @Validate({ params: personIdParams })
  remove(
    @Param("personId", ParseIntPipe) personId: number,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.people.remove(
      currentUser.orgId,
      personId,
      currentUser.userId,
    );
  }
}
