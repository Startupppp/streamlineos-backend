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
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
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

@RequireModule("projects")
@Controller("timesheets/entries")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class EntriesController {
  constructor(private readonly entries: EntriesService) {}

  @Get()
  @RequirePermission("timesheets:entries:view")
  list(
    @Query(new ZodValidationPipe(entriesQuerySchema)) query: EntriesQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.entries.listEntries(u, query);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("timesheets:entries:create")
  create(
    @Body(new ZodValidationPipe(createEntrySchema)) body: CreateEntryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.entries.createEntry(u, body);
  }

  @Patch(":entryId")
  @RequirePermission("timesheets:entries:update")
  update(
    @Param("entryId", ParseIntPipe) entryId: number,
    @Body(new ZodValidationPipe(updateEntrySchema)) body: UpdateEntryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.entries.updateEntry(u, entryId, body);
  }

  @Post(":entryId/void")
  @HttpCode(200)
  @RequirePermission("timesheets:entries:void")
  void(
    @Param("entryId", ParseIntPipe) entryId: number,
    @Body(new ZodValidationPipe(voidEntrySchema)) body: VoidEntryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.entries.voidEntry(u, entryId, body);
  }
}
