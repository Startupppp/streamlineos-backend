import {
  Body,
  Controller,
  Get,
  HttpCode,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { Validate } from "../../../common/validation/validate.decorator";
import { BackgroundVerificationService } from "./background-verification.service";
import {
  createBgvSchema,
  updateBgvSchema,
  type CreateBgvInput,
  type UpdateBgvInput,
} from "./dto/hr-directory.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";

@RequireModule("hr")
@Controller("hr/background-verification")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class BackgroundVerificationController {
  constructor(private readonly bgv: BackgroundVerificationService) {}

  @Get()
  @RequirePermission("hr:sensitive:view")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.bgv.list(u.orgId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("hr:sensitive:manage")
  @Validate({ body: createBgvSchema })
  create(
    @Body() body: CreateBgvInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.bgv.create(u.orgId, body);
  }

  @Patch()
  @RequirePermission("hr:sensitive:manage")
  @Validate({ body: updateBgvSchema })
  update(
    @Body() body: UpdateBgvInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.bgv.update(u.orgId, body);
  }
}
