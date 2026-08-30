import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
  Query,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { AccessService } from "../../access/access.service";
import { FnfService } from "./fnf.service";
import {
  createFnfSchema,
  patchFnfSchema,
  type CreateFnfInput,
  type PatchFnfInput,
  listPageQuerySchema,
  type ListPageQueryInput,
} from "./dto/payroll.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const fnfIdParams = z.object({ fnfId: z.coerce.number().int().positive() }).strict();

@RequireModule("payroll")
@Controller("hr/fnf")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class FnfController {
  constructor(
    private readonly fnf: FnfService,
    private readonly access: AccessService,
  ) {}

  @Get()
  @RequirePermission("hr:payroll:view")
  async list(
    @CurrentUser() u: CurrentUserContext,
    @Query(new ZodValidationPipe(listPageQuerySchema)) query: ListPageQueryInput,
  ) {
    let isAdmin = u.isOrgOwner;
    if (!isAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      isAdmin = perms.has("hr:payroll:approve");
    }
    return this.fnf.listFnf(u.orgId, u.userId, isAdmin, query.page ?? 1, query.limit ?? 100);
  }

  @Post()
  @RequirePermission("hr:exit:manage")
  @HttpCode(201)
  async create(
    @Body(new ZodValidationPipe(createFnfSchema)) body: CreateFnfInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.fnf.createFnf(u.orgId, body);
    if (!result.ok) throw new NotFoundException("User not found in your organization");
    return result.record;
  }

  @Patch(":fnfId")
  @RequirePermission("hr:exit:manage")
  @Validate({ params: fnfIdParams })
  async update(
    @Param("fnfId", ParseIntPipe) fnfId: number,
    @Body(new ZodValidationPipe(patchFnfSchema)) body: PatchFnfInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.fnf.updateFnf(u.orgId, u.userId, fnfId, body);
    if (!result.ok) throw new NotFoundException("F&F settlement not found.");
    return result.record;
  }
}
