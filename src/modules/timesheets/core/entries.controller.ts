import {
  Body,
  Controller,
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
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { EntriesService } from "./entries.service";
import { AttendanceDraftService } from "./attendance/attendance-draft.service";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import {
  entriesQuerySchema,
  createEntrySchema,
  updateEntrySchema,
  voidEntrySchema,
  draftFromAttendanceSchema,
  type EntriesQuery,
  type CreateEntryInput,
  type UpdateEntryInput,
  type VoidEntryInput,
  type DraftFromAttendanceInput,
} from "./dto/entries.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { successSchema } from "../../../common/openapi/response-envelopes";
import {
  attendanceDraftResponseSchema,
  entriesListResponseSchema,
  entrySchema,
} from "./dto/timesheets-response.schemas";
import { z } from "zod";

const entryIdParams = z.object({ entryId: z.coerce.number().int().positive() }).strict();

@RequireModule("timesheets")
@Controller("timesheets/entries")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class EntriesController {
  constructor(
    private readonly entries: EntriesService,
    private readonly attendanceDrafts: AttendanceDraftService,
  ) {}

  @Get()
  @RequirePermission("timesheets:entries:view")
  @Validate({ query: entriesQuerySchema })
  @ResponseSchema(entriesListResponseSchema)
  list(
    @Query() query: EntriesQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.entries.listEntries(u, query);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("timesheets:entries:create")
  @Validate({ body: createEntrySchema })
  @Idempotent("timesheets.entry.create", { required: false })
  @ResponseSchema(entrySchema)
  create(
    @Body() body: CreateEntryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.entries.createEntry(u, body);
  }

  @Patch(":entryId")
  @RequirePermission("timesheets:entries:update")
  @Validate({ params: entryIdParams, body: updateEntrySchema })
  @ResponseSchema(entrySchema)
  update(
    @Param("entryId", ParseIntPipe) entryId: number,
    @Body() body: UpdateEntryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.entries.updateEntry(u, entryId, body);
  }

  @Post(":entryId/void")
  @HttpCode(200)
  @RequirePermission("timesheets:entries:void")
  @Validate({ params: entryIdParams, body: voidEntrySchema })
  @Idempotent("timesheets.entry.void", { required: false })
  @ResponseSchema(successSchema)
  void(
    @Param("entryId", ParseIntPipe) entryId: number,
    @Body() body: VoidEntryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.entries.voidEntry(u, entryId, body);
  }

  @Post("from-attendance")
  @HttpCode(200)
  @RequirePermission("timesheets:entries:create")
  @Validate({ body: draftFromAttendanceSchema })
  @Idempotent("timesheets.entries.from_attendance", { required: false })
  @ResponseSchema(attendanceDraftResponseSchema)
  draftFromAttendance(
    @Body() body: DraftFromAttendanceInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.attendanceDrafts.draftForUser(u, body);
  }
}
