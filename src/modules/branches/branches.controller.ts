import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { hasRoleOrPrivileged } from "../../common/auth/role-access";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { BranchesService } from "./branches.service";
import {
  createBranchSchema,
  updateBranchSchema,
  type CreateBranchInput,
  type UpdateBranchInput,
} from "./dto/branches.schemas";

const MANAGE_ROLES = ["HR", "CEO"];

@Controller("branches")
@UseGuards(JwtAuthGuard)
export class BranchesController {
  constructor(private readonly branches: BranchesService) {}

  @Get()
  list(@CurrentUser() u: CurrentUserContext) {
    return this.branches.list(u.orgId);
  }

  @Get(":branchId")
  async getOne(
    @Param("branchId", ParseIntPipe) branchId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const branch = await this.branches.getOne(u.orgId, branchId);
    if (!branch) throw new NotFoundException("Branch not found");
    return branch;
  }

  @Post()
  async create(
    @Body(new ZodValidationPipe(createBranchSchema)) body: CreateBranchInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!hasRoleOrPrivileged(u, MANAGE_ROLES)) {
      throw new ForbiddenException("Only HR/CEO can create branches");
    }
    return this.branches.create(u.orgId, body);
  }

  @Patch(":branchId")
  async update(
    @Param("branchId", ParseIntPipe) branchId: number,
    @Body(new ZodValidationPipe(updateBranchSchema)) body: UpdateBranchInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!hasRoleOrPrivileged(u, MANAGE_ROLES)) {
      throw new ForbiddenException("Forbidden");
    }
    const updated = await this.branches.update(u.orgId, branchId, body);
    if (!updated) throw new NotFoundException("Branch not found");
    return updated;
  }

  @Delete(":branchId")
  async remove(
    @Param("branchId", ParseIntPipe) branchId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!hasRoleOrPrivileged(u, MANAGE_ROLES)) {
      throw new ForbiddenException("Forbidden");
    }
    const deleted = await this.branches.remove(u.orgId, branchId);
    if (!deleted) throw new NotFoundException("Branch not found");
    return deleted;
  }
}
