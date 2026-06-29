import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { BackgroundVerificationService } from "./background-verification.service";
import { userCan } from "./ability.helpers";
import {
  createBgvSchema,
  updateBgvSchema,
  type CreateBgvInput,
  type UpdateBgvInput,
} from "./dto/hr-directory.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";

@RequireModule("hr")
@Controller("hr/background-verification")
@UseGuards(JwtAuthGuard)
export class BackgroundVerificationController {
  constructor(private readonly bgv: BackgroundVerificationService) {}

  @Get()
  list(@CurrentUser() u: CurrentUserContext) {
    return this.bgv.list(u.orgId);
  }

  @Post()
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createBgvSchema)) body: CreateBgvInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!userCan(u, "manage", "hr:employees")) {
      throw new ForbiddenException("Only admins can initiate verifications.");
    }
    return this.bgv.create(u.orgId, body);
  }

  @Patch()
  update(
    @Body(new ZodValidationPipe(updateBgvSchema)) body: UpdateBgvInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!userCan(u, "manage", "hr:employees")) {
      throw new ForbiddenException("Only admins can update verifications.");
    }
    return this.bgv.update(u.orgId, body);
  }
}
