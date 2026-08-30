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
import {
  entriesQuerySchema,
  createEntrySchema,
  updateEntrySchema,
  voidEntrySchema,
  type EntriesQuery,
  type CreateEntryInput,
  type UpdateEntryInput,
  type VoidEntryInput,
} from "./dto/entries.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const entryIdParams = z.object({ entryId: z.coerce.number().int().positive() }).strict();

@RequireModule("build")
@Controller("timesheets/entries")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class EntriesController {
  constructor(private readonly entries: EntriesService) {}

  @Get()
  @RequirePermission("timesheets:entries:view")
  @Validate({ query: entriesQuerySchema })
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
  create(
    @Body() body: CreateEntryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.entries.createEntry(u, body);
  }

  @Patch(":entryId")
  @RequirePermission("timesheets:entries:update")
  @Validate({ params: entryIdParams, body: updateEntrySchema })
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
  void(
    @Param("entryId", ParseIntPipe) entryId: number,
    @Body() body: VoidEntryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.entries.voidEntry(u, entryId, body);
  }
}
