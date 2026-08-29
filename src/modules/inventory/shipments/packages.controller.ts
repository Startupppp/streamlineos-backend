import { Controller, Get, Post, Patch, Param, Body, Query, ParseIntPipe, UseGuards, HttpCode, HttpStatus } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { IdempotencyKey } from "../../../common/idempotency/idempotency-key.decorator";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { PackagesService } from "./packages.service";
import {
  listPackagesQuerySchema,
  createPackageSchema,
  updatePackageLinesSchema,
  scanIntoPackageSchema,
  closePackageSchema,
  packingQueueQuerySchema,
  type ListPackagesQueryInput,
  type CreatePackageInput,
  type UpdatePackageLinesInput,
  type ScanIntoPackageInput,
  type ClosePackageInput,
  type PackingQueueQueryInput,
} from "./dto/shipments.schemas";

@RequireModule("inventory")
@Controller("inventory/packages")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class PackagesController {
  constructor(private readonly svc: PackagesService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:packages:manage")
  list(
    @Query(new ZodValidationPipe(listPackagesQuerySchema)) query: ListPackagesQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.list(u.orgId, u.userId, query);
  }

  /**
   * B6. Declared before `:packageId` on purpose: Nest matches in declaration
   * order, and behind the parameterised route "queue" reaches `ParseIntPipe` and
   * comes back a 400 nobody can read.
   */
  @Get("queue")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:packages:manage")
  queue(
    @Query(new ZodValidationPipe(packingQueueQuerySchema)) query: PackingQueueQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.packingQueue(u.orgId, u.userId, query);
  }

  @Get(":packageId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:packages:manage")
  findOne(
    @Param("packageId", ParseIntPipe) packageId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.findOne(u.orgId, packageId);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:packages:manage")
  create(
    @Body(new ZodValidationPipe(createPackageSchema)) body: CreatePackageInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.create(u.orgId, u.userId, body);
  }

  @Patch(":packageId/lines")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:packages:manage")
  updateLines(
    @Param("packageId", ParseIntPipe) packageId: number,
    @Body(new ZodValidationPipe(updatePackageLinesSchema)) body: UpdatePackageLinesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateLines(u.orgId, u.userId, packageId, body);
  }

  @Get(":packageId/reconciliation")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:packages:manage")
  reconciliation(
    @Param("packageId", ParseIntPipe) packageId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.reconciliation(u.orgId, packageId);
  }

  @Post(":packageId/scan")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:packages:manage")
  @HttpCode(HttpStatus.OK)
  scan(
    @IdempotencyKey() idempotencyKey: string,
    @Param("packageId", ParseIntPipe) packageId: number,
    @Body(new ZodValidationPipe(scanIntoPackageSchema)) body: ScanIntoPackageInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.scan(u.orgId, u.userId, packageId, body, idempotencyKey);
  }

  @Post(":packageId/close")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:packages:manage")
  @HttpCode(HttpStatus.OK)
  close(
    @Param("packageId", ParseIntPipe) packageId: number,
    @Body(new ZodValidationPipe(closePackageSchema)) body: ClosePackageInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.close(u.orgId, u.userId, packageId, body);
  }

  @Post(":packageId/reopen")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:packages:manage")
  @HttpCode(HttpStatus.OK)
  reopen(
    @Param("packageId", ParseIntPipe) packageId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.reopen(u.orgId, u.userId, packageId);
  }
}
