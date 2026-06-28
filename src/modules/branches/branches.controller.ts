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
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { AccessService } from "../access/access.service";
import { BranchesService } from "./branches.service";
import {
  createBranchSchema,
  updateBranchSchema,
  type CreateBranchInput,
  type UpdateBranchInput,
} from "./dto/branches.schemas";

@Controller("branches")
@UseGuards(JwtAuthGuard)
export class BranchesController {
  constructor(
    private readonly branches: BranchesService,
    private readonly access: AccessService,
  ) {}

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
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("branch:create")) {
        throw new ForbiddenException("Only HR/CEO can create branches");
      }
    }
    return this.branches.create(u.orgId, body);
  }

  @Patch(":branchId")
  async update(
    @Param("branchId", ParseIntPipe) branchId: number,
    @Body(new ZodValidationPipe(updateBranchSchema)) body: UpdateBranchInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("branch:update")) {
        throw new ForbiddenException("Forbidden");
      }
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
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("branch:update")) {
        throw new ForbiddenException("Forbidden");
      }
    }
    const deleted = await this.branches.remove(u.orgId, branchId);
    if (!deleted) throw new NotFoundException("Branch not found");
    return deleted;
  }
}
