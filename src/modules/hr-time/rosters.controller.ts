import { Controller, Get, Post, Patch, Body, Param, ParseIntPipe, UseGuards, HttpCode } from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { RostersService } from "./rosters.service";

const createRosterSchema = z.object({
  name: z.string().min(1).max(100),
  weekStart: z.string().min(1),
  weekEnd: z.string().min(1),
});

const upsertRosterEntrySchema = z.object({
  userId: z.string().min(1),
  shiftId: z.number().int().positive().optional(),
  date: z.string().min(1),
  isDayOff: z.boolean().optional(),
  notes: z.string().max(500).optional(),
});

type CreateRosterInput = z.infer<typeof createRosterSchema>;
type UpsertRosterEntryInput = z.infer<typeof upsertRosterEntrySchema>;

@RequireModule("hr")
@UseGuards(JwtAuthGuard)
@Controller("hr/rosters")
export class RostersController {
  constructor(private readonly service: RostersService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:attendance:view")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.service.listRosters(u.orgId);
  }

  @Post()
  @HttpCode(201)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:attendance:manage")
  create(
    @CurrentUser() u: CurrentUserContext,
    @Body(new ZodValidationPipe(createRosterSchema)) body: CreateRosterInput,
  ) {
    return this.service.createRoster(u.orgId, u.userId, body);
  }

  @Get(":rosterId/entries")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:attendance:view")
  getEntries(@CurrentUser() u: CurrentUserContext, @Param("rosterId", ParseIntPipe) rosterId: number) {
    return this.service.getRosterEntries(u.orgId, rosterId);
  }

  @Post(":rosterId/entries")
  @HttpCode(201)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:attendance:manage")
  upsertEntry(
    @CurrentUser() u: CurrentUserContext,
    @Param("rosterId", ParseIntPipe) rosterId: number,
    @Body(new ZodValidationPipe(upsertRosterEntrySchema)) body: UpsertRosterEntryInput,
  ) {
    return this.service.upsertRosterEntry(u.orgId, { rosterId, ...body });
  }

  @Patch(":rosterId/publish")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:attendance:manage")
  publish(@CurrentUser() u: CurrentUserContext, @Param("rosterId", ParseIntPipe) rosterId: number) {
    return this.service.publishRoster(u.orgId, rosterId);
  }
}
