import { Controller, Get, Post, Patch, Body, Param, ParseIntPipe, UseGuards, HttpCode } from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

import { RostersService } from "./rosters.service";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { rosterRowSchema, rosterEntryRowSchema } from "./dto/time-wfh-shifts-response.schemas";

const rosterIdParams = z.object({ rosterId: z.coerce.number().int().positive() }).strict();

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
  @ResponseSchema(z.array(rosterRowSchema))
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:attendance:view")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.service.listRosters(u.orgId);
  }

  @Post()
  @HttpCode(201)
  @ResponseSchema(rosterRowSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:attendance:manage")
  @Validate({ body: createRosterSchema })
  create(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: CreateRosterInput,
  ) {
    return this.service.createRoster(u.orgId, u.userId, body);
  }

  @Get(":rosterId/entries")
  @ResponseSchema(z.array(rosterEntryRowSchema))
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:attendance:view")
  @Validate({ params: rosterIdParams })
  getEntries(@CurrentUser() u: CurrentUserContext, @Param("rosterId", ParseIntPipe) rosterId: number) {
    return this.service.getRosterEntries(u.orgId, rosterId);
  }

  @Post(":rosterId/entries")
  @HttpCode(201)
  @ResponseSchema(rosterEntryRowSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:attendance:manage")
  @Validate({ params: rosterIdParams, body: upsertRosterEntrySchema })
  upsertEntry(
    @CurrentUser() u: CurrentUserContext,
    @Param("rosterId", ParseIntPipe) rosterId: number,
    @Body() body: UpsertRosterEntryInput,
  ) {
    return this.service.upsertRosterEntry(u.orgId, { rosterId, ...body });
  }

  @Patch(":rosterId/publish")
  @BodylessAction()
  @ResponseSchema(rosterRowSchema)
  @Idempotent("hr.roster.publish")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:attendance:manage")
  @Validate({ params: rosterIdParams })
  publish(@CurrentUser() u: CurrentUserContext, @Param("rosterId", ParseIntPipe) rosterId: number) {
    return this.service.publishRoster(u.orgId, rosterId);
  }
}
