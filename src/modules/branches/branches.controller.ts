import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { BranchesService } from "./branches.service";
import {
  createBranchSchema,
  updateBranchSchema,
  type CreateBranchInput,
  type UpdateBranchInput,
} from "./dto/branches.schemas";

@Controller("branches")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class BranchesController {
  constructor(private readonly branches: BranchesService) {}

  @Get()
  @RequirePermission("branch:view")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.branches.list(u.orgId);
  }

  @Get(":branchId")
  @RequirePermission("branch:view")
  async getOne(
    @Param("branchId") branchId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const branch = await this.branches.getOne(u.orgId, branchId);
    if (!branch) throw new NotFoundException("Branch not found");
    return branch;
  }

  @Post()
  @RequirePermission("branch:create")
  async create(
    @Body(new ZodValidationPipe(createBranchSchema)) body: CreateBranchInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.branches.create(u.orgId, body);
  }

  @Patch(":branchId")
  @RequirePermission("branch:update")
  async update(
    @Param("branchId") branchId: string,
    @Body(new ZodValidationPipe(updateBranchSchema)) body: UpdateBranchInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const updated = await this.branches.update(u.orgId, branchId, body);
    if (!updated) throw new NotFoundException("Branch not found");
    return updated;
  }

  @Delete(":branchId")
  @RequirePermission("branch:delete")
  async remove(
    @Param("branchId") branchId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const deleted = await this.branches.remove(u.orgId, branchId);
    if (!deleted) throw new NotFoundException("Branch not found");
    return deleted;
  }
}
