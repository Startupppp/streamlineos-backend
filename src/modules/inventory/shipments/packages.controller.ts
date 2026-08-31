import { Controller, Get, Post, Patch, Param, Body, Query, ParseIntPipe, UseGuards, HttpCode, HttpStatus } from "@nestjs/common";
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
  type ListPackagesQueryInput,
  type CreatePackageInput,
  type UpdatePackageLinesInput,
} from "./dto/shipments.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";

const packageIdParams = z.object({ packageId: z.coerce.number().int().positive() }).strict();

@RequireModule("inventory")
@Controller("inventory/packages")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class PackagesController {
  constructor(private readonly svc: PackagesService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:packages:manage")
  @Validate({ query: listPackagesQuerySchema })
  list(
    @Query() query: ListPackagesQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.list(u.orgId, query);
  }

  @Get(":packageId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:packages:manage")
  @Validate({ params: packageIdParams })
  findOne(
    @Param("packageId", ParseIntPipe) packageId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.findOne(u.orgId, packageId);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:packages:manage")
  @Validate({ body: createPackageSchema })
  create(
    @Body() body: CreatePackageInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.create(u.orgId, u.userId, body);
  }

  @Patch(":packageId/lines")
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

  @Post(":packageId/close")
  @BodylessAction()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:packages:manage")
  @HttpCode(HttpStatus.OK)
  @Validate({ params: packageIdParams })
  close(
    @Param("packageId", ParseIntPipe) packageId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.close(u.orgId, u.userId, packageId);
  }

  @Post(":packageId/reopen")
  @BodylessAction()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:packages:manage")
  @HttpCode(HttpStatus.OK)
  @Validate({ params: packageIdParams })
  reopen(
    @Param("packageId", ParseIntPipe) packageId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.reopen(u.orgId, u.userId, packageId);
  }
}
