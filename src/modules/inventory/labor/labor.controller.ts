import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { LaborService } from "./labor.service";
import { laborBoardQuerySchema, laborRecentQuerySchema } from "./dto/labor.schemas";
import type { LaborBoardQuery, LaborRecentQuery } from "./dto/labor.schemas";

/**
 * NEO-7 - the supervisor board.
 *
 * `inventory:labor:read` rather than `inventory:reports:read`, and the
 * difference is the point: this screen names individual people and rates their
 * work. That is an authority an organisation should grant deliberately, to the
 * handful of people who supervise, rather than one that arrives with the
 * ability to read a stock summary.
 *
 * Nothing here writes. Labour records are written from inside the commands that
 * finish the work; this module only reads them back.
 */
@RequireModule("inventory")
@Controller("inventory/labor")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class LaborController {
  constructor(private readonly svc: LaborService) {}

  @Get("board")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:labor:read")
  board(
    @Query(new ZodValidationPipe(laborBoardQuerySchema)) query: LaborBoardQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.board(u.orgId, u.userId, query);
  }

  @Get("records")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:labor:read")
  records(
    @Query(new ZodValidationPipe(laborRecentQuerySchema)) query: LaborRecentQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.recentFor(u.orgId, u.userId, query.userId, query.limit);
  }
}
