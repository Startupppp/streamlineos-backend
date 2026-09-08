import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  ParseIntPipe,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { DockService } from "./dock.service";
import {
  bookAppointmentSchema,
  createDockDoorSchema,
  listAppointmentsQuerySchema,
  setAppointmentStatusSchema,
} from "./dto/dock.schemas";
import type {
  BookAppointmentInput,
  CreateDockDoorInput,
  ListAppointmentsQuery,
  SetAppointmentStatusInput,
} from "./dto/dock.schemas";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";

/**
 * NEO-12 - the dock calendar.
 *
 * Doors are `inventory:warehouses:manage`: a door is part of the building, and
 * that is the key that already governs warehouses and bins. Booking a slot is
 * `inventory:dock:manage`, its own key, because the people who book vehicles in
 * are receiving clerks and transport planners rather than whoever configures the
 * site.
 */
@RequireModule("inventory")
@Controller("inventory/dock")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class DockController {
  constructor(private readonly svc: DockService) {}

  @Get("doors")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:warehouses:read")
  listDoors(
    @Query("warehouseId") warehouseId: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listDoors(u.orgId, u.userId, warehouseId ? Number(warehouseId) : undefined);
  }

  @Post("doors")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:warehouses:manage")
  @Idempotent("inventory.dock.door.create")
  createDoor(
    @Body(new ZodValidationPipe(createDockDoorSchema)) body: CreateDockDoorInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createDoor(u.orgId, u.userId, body);
  }

  @Get("appointments")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:dock:manage")
  list(
    @Query(new ZodValidationPipe(listAppointmentsQuerySchema)) query: ListAppointmentsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.list(u.orgId, u.userId, query);
  }

  @Post("appointments")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:dock:manage")
  @Idempotent("inventory.dock.appointment.book")
  book(
    @Body(new ZodValidationPipe(bookAppointmentSchema)) body: BookAppointmentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.book(u.orgId, u.userId, body);
  }

  @Patch("appointments/:appointmentId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:dock:manage")
  setStatus(
    @Param("appointmentId", ParseIntPipe) appointmentId: number,
    @Body(new ZodValidationPipe(setAppointmentStatusSchema)) body: SetAppointmentStatusInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.setStatus(u.orgId, u.userId, appointmentId, body.status);
  }
}
