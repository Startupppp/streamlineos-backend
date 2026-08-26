import { Body, Controller, Delete, Get, Inject, Param, Put, UseGuards } from "@nestjs/common";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { Validate } from "../../common/validation/validate.decorator";
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import { RecordLayoutsService, type LayoutUsage } from "./record-layouts.service";
import { layoutUsage } from "./layout-usage";
import {
  layoutAdjustmentInputSchema,
  layoutKeyParamSchema,
  type LayoutAdjustmentInput,
} from "./dto/layout.schemas";

/**
 * A tenant's arrangement of a record type.
 *
 * The read is **ungated on purpose**. An arrangement carries no record data —
 * only field names the layout description already publishes — and every list,
 * detail view and form in the CRM reads it in order to render at all. Gating it
 * would mean a member without an administration permission renders the declared
 * layout while their colleague renders the tenant's, which is a worse failure
 * than the one the gate would prevent.
 *
 * Writing is administration and carries its own key. `PermissionGuard` is not
 * global, so it sits on the handlers that need it rather than on the class —
 * putting it on the class would deny the read, which carries no key.
 */
@Controller("renderer/layouts")
@UseGuards(JwtAuthGuard)
export class RecordLayoutsController {
  constructor(
    private readonly layouts: RecordLayoutsService,
    @Inject(DRIZZLE) private readonly db: Db,
  ) {}

  @Get(":layoutKey")
  @Validate({ params: layoutKeyParamSchema })
  async get(@CurrentUser() user: CurrentUserContext, @Param("layoutKey") layoutKey: string) {
    return this.layouts.get(user.orgId, layoutKey);
  }

  @Put(":layoutKey")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:record-layouts:manage")
  @Idempotent("renderer.layout.save")
  @Validate({ params: layoutKeyParamSchema, body: layoutAdjustmentInputSchema })
  async save(
    @CurrentUser() user: CurrentUserContext,
    @Param("layoutKey") layoutKey: string,
    @Body() body: LayoutAdjustmentInput,
  ) {
    return this.layouts.save(user.orgId, layoutKey, body);
  }

  @Delete(":layoutKey")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:record-layouts:manage")
  @Validate({ params: layoutKeyParamSchema })
  async reset(@CurrentUser() user: CurrentUserContext, @Param("layoutKey") layoutKey: string) {
    await this.layouts.reset(user.orgId, layoutKey);
    return null;
  }

  /**
   * Gated with the write, not the read: it is the input to a proposal, which is
   * an administrator's business, and it reads across the tenant's records.
   */
  @Get(":layoutKey/usage")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:record-layouts:manage")
  @Validate({ params: layoutKeyParamSchema })
  async usage(
    @CurrentUser() user: CurrentUserContext,
    @Param("layoutKey") layoutKey: string,
  ): Promise<LayoutUsage> {
    return layoutUsage(this.db, user.orgId, layoutKey);
  }
}
