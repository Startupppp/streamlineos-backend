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
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
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
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { IdempotencyKey } from "../../../common/idempotency/idempotency-key.decorator";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import {
  listPackagesResponseSchema,
  getPackageResponseSchema,
  invPackageSchema,
  packageReconciliationResponseSchema,
  packingQueueResponseSchema,
} from "./dto/shipments-response.schemas";

const packageIdParams = z.object({ packageId: z.coerce.number().int().positive() }).strict();

@RequireModule("inventory")
@Controller("inventory/packages")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class PackagesController {
  constructor(private readonly svc: PackagesService) {}

  @Get()
  @ResponseSchema(listPackagesResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:packages:manage")
  @Validate({ query: listPackagesQuerySchema })
  list(
    @Query() query: ListPackagesQueryInput,
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
  @ResponseSchema(packingQueueResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:packages:manage")
  @Validate({ query: packingQueueQuerySchema })
  queue(
    @Query() query: PackingQueueQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.packingQueue(u.orgId, u.userId, query);
  }

  @Get(":packageId")
  @ResponseSchema(getPackageResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:packages:manage")
  @Validate({ params: packageIdParams })
  findOne(
    @Param("packageId", ParseIntPipe) packageId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.findOne(u.orgId, u.userId, packageId);
  }

  @Post()
  @ResponseSchema(invPackageSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:packages:manage")
  @Idempotent("inventory.package.create")
  @Validate({ body: createPackageSchema })
  create(
    @Body() body: CreatePackageInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.create(u.orgId, u.userId, body);
  }

  @Patch(":packageId/lines")
  @ResponseSchema(getPackageResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:packages:manage")
  @Validate({ params: packageIdParams, body: updatePackageLinesSchema })
  updateLines(
    @Param("packageId", ParseIntPipe) packageId: number,
    @Body() body: UpdatePackageLinesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateLines(u.orgId, u.userId, packageId, body);
  }

  @Get(":packageId/reconciliation")
  @ResponseSchema(packageReconciliationResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:packages:manage")
  reconciliation(
    @Param("packageId", ParseIntPipe) packageId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.reconciliation(u.orgId, u.userId, packageId);
  }

  @Post(":packageId/scan")
  @ResponseSchema(packageReconciliationResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:packages:manage")
  @HttpCode(HttpStatus.OK)
  @Validate({ params: packageIdParams, body: scanIntoPackageSchema })
  scan(
    @IdempotencyKey() idempotencyKey: string,
    @Param("packageId", ParseIntPipe) packageId: number,
    @Body() body: ScanIntoPackageInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.scan(u.orgId, u.userId, packageId, body, idempotencyKey);
  }

  @Post(":packageId/close")
  @ResponseSchema(getPackageResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:packages:manage")
  @Idempotent("inventory.package.close")
  @HttpCode(HttpStatus.OK)
  @Validate({ params: packageIdParams, body: closePackageSchema })
  close(
    @Param("packageId", ParseIntPipe) packageId: number,
    @Body() body: ClosePackageInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.close(u.orgId, u.userId, packageId, body);
  }

  @Post(":packageId/reopen")
  @BodylessAction()
  @ResponseSchema(getPackageResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:packages:manage")
  @Idempotent("inventory.package.reopen")
  @HttpCode(HttpStatus.OK)
  @Validate({ params: packageIdParams })
  reopen(
    @Param("packageId", ParseIntPipe) packageId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.reopen(u.orgId, u.userId, packageId);
  }
}
