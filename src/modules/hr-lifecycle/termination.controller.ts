import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
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
import { TerminationService } from "./termination.service";
import { userCan } from "./ability.helper";
import {
  terminationCreateSchema,
  terminationReviewSchema,
  type TerminationCreateInput,
  type TerminationReviewInput,
} from "./dto/hr-lifecycle.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";

@RequireModule("hr")
@Controller("hr/termination")
@UseGuards(JwtAuthGuard)
export class TerminationController {
  constructor(
    private readonly termination: TerminationService,
    private readonly access: AccessService,
  ) {}

  private async assertManageAccess(u: CurrentUserContext): Promise<void> {
    if (u.isOrgOwner || u.isPlatformAdmin || userCan(u, "manage", "hr:employees")) return;
    const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
    if (!perms.has("hr:exit:manage")) {
      throw new ForbiddenException("Forbidden");
    }
  }

  private async assertExitManage(u: CurrentUserContext, message: string): Promise<void> {
    if (u.isOrgOwner || u.isPlatformAdmin) return;
    const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
    if (!perms.has("hr:exit:manage")) {
      throw new ForbiddenException(message);
    }
  }

  @Get()
  async list(@CurrentUser() u: CurrentUserContext) {
    await this.assertManageAccess(u);
    return this.termination.list(u.orgId);
  }

  @Post()
  @HttpCode(201)
  async create(
    @Body(new ZodValidationPipe(terminationCreateSchema)) body: TerminationCreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.assertExitManage(u, "Only HR or CEO can initiate terminations.");
    return this.termination.create(u.orgId, u.userId, u.role, body);
  }

  @Post(":terminationId/send-email")
  @HttpCode(200)
  async sendEmail(
    @Param("terminationId", ParseIntPipe) terminationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.assertExitManage(u, "Only HR can send termination emails.");
    return this.termination.sendEmail(u.orgId, u.userId, terminationId);
  }

  @Patch(":terminationId/complete")
  async complete(
    @Param("terminationId", ParseIntPipe) terminationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.assertExitManage(u, "Only HR can complete terminations.");
    return this.termination.complete(u.orgId, u.userId, terminationId);
  }

  @Get(":terminationId/letter")
  async getLetter(
    @Param("terminationId", ParseIntPipe) terminationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.assertManageAccess(u);
    return this.termination.getLetter(u.orgId, terminationId);
  }

  @Patch(":terminationId/submit")
  async submit(
    @Param("terminationId", ParseIntPipe) terminationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.assertExitManage(u, "Only HR can submit for CEO approval.");
    return this.termination.submit(u.orgId, u.userId, terminationId);
  }

  @Patch(":terminationId/ceo-review")
  async ceoReview(
    @Param("terminationId", ParseIntPipe) terminationId: number,
    @Body(new ZodValidationPipe(terminationReviewSchema)) body: TerminationReviewInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.assertExitManage(u, "Only CEO can review terminations.");
    return this.termination.ceoReview(u.orgId, u.userId, terminationId, body);
  }

  @Get(":terminationId")
  async getOne(
    @Param("terminationId", ParseIntPipe) terminationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.assertManageAccess(u);
    return this.termination.getOne(u.orgId, terminationId);
  }
}
