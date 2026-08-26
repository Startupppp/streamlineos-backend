import { Body, Controller, Delete, Get, Param, Put, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import {
  layoutKeySchema,
  saveLayoutAdjustmentSchema,
  type SaveLayoutAdjustmentInput,
} from "./dto/record-layouts.schemas";
import { RecordLayoutsService } from "./record-layouts.service";

/**
 * Where a tenant's arrangement of a record type is read and written.
 *
 * **The organisation is never in the request.** `orgId` comes from
 * `@CurrentUser()` on all four routes; there is no body field, query parameter
 * or path segment that names a tenant. `layoutKey` addresses a record type, not
 * a row — one tenant's `crm:lead` and another's are different rows behind the
 * same URL, and RLS refuses the second one even if this code forgot to.
 *
 * **Reading carries no permission key, and that is the design.** An arrangement
 * holds only field names the description already publishes, and every list,
 * detail view and form in the CRM reads it in order to render at all. Gating the
 * read would mean an unprivileged colleague saw a different arrangement from a
 * privileged one — a screen that disagrees with itself depending on who is
 * looking, for data that is not sensitive. So the read is authenticated and
 * nothing more, and the three routes that CHANGE the arrangement carry the key.
 *
 * `PermissionGuard` is not global. It is named on each gated handler, and it is
 * deliberately NOT at class level: the guard denies any handler it runs on that
 * has no `@RequirePermission`, so a class-level guard would 403 the read.
 *
 * No `@RequireModule`. A tenant without the CRM module still renders `party`,
 * and a 402 on the read would take every record surface down with it.
 */
@Controller("renderer/layouts")
export class RecordLayoutsController {
  constructor(private readonly layouts: RecordLayoutsService) {}

  @Get(":layoutKey")
  get(
    @Param("layoutKey", new ZodValidationPipe(layoutKeySchema)) layoutKey: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.layouts.get(u.orgId, layoutKey);
  }

  @Put(":layoutKey")
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission("settings:record-layouts:manage")
  save(
    @Param("layoutKey", new ZodValidationPipe(layoutKeySchema)) layoutKey: string,
    @Body(new ZodValidationPipe(saveLayoutAdjustmentSchema)) body: SaveLayoutAdjustmentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.layouts.save(u.orgId, u.userId, layoutKey, body);
  }

  @Delete(":layoutKey")
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission("settings:record-layouts:manage")
  reset(
    @Param("layoutKey", new ZodValidationPipe(layoutKeySchema)) layoutKey: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.layouts.remove(u.orgId, layoutKey);
  }

  /**
   * What this tenant actually fills in, so a proposal is evidence rather than
   * opinion.
   *
   * Gated with the manage key rather than left open: the counts are a summary of
   * the tenant's own records, which the arrangement itself is not. A person who
   * may not rearrange the record type has no reason to be told how many of its
   * deals carry a lost reason.
   */
  @Get(":layoutKey/usage")
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission("settings:record-layouts:manage")
  usage(
    @Param("layoutKey", new ZodValidationPipe(layoutKeySchema)) layoutKey: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.layouts.usage(u.orgId, layoutKey);
  }
}
