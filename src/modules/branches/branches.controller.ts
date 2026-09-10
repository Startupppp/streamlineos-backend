import {
  Controller,
  Get,
  NotFoundException,
  Param,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { BranchesReadService } from "./branches-read.service";
import { Validate } from "../../common/validation/validate.decorator";
import { ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import { z } from "zod";
import {
  branchListSchema,
  branchDetailSchema,
} from "./dto/branches-response.schemas";

const branchIdParams = z.object({ branchId: z.string().min(1) }).strict();

@Controller("branches")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class BranchesController {
  constructor(private readonly branches: BranchesReadService) {}

  @Get()
  @RequirePermission("branch:view")
  @ResponseSchema(branchListSchema)
  list(@CurrentUser() u: CurrentUserContext) {
    return this.branches.list(u.orgId);
  }

  @Get(":branchId")
  @RequirePermission("branch:view")
  @ResponseSchema(branchDetailSchema)
  @Validate({ params: branchIdParams })
  async getOne(
    @Param("branchId") branchId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const branch = await this.branches.getOne(u.orgId, branchId);
    if (!branch) throw new NotFoundException("Branch not found");
    return branch;
  }
}
