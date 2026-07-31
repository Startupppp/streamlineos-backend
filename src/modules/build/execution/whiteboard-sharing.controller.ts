import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Public } from "../../../common/auth/public.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { RateLimitService } from "../../../common/ratelimit/rate-limit.service";
import { WhiteboardSharingService } from "./whiteboard-sharing.service";
import {
  publicWhiteboardUpdateSchema,
  setWhiteboardSharesSchema,
  updateWhiteboardSharingSchema,
  type PublicWhiteboardUpdateInput,
  type SetWhiteboardSharesInput,
  type UpdateWhiteboardSharingInput,
} from "./dto/workspace.schemas";

function clientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return (raw ?? req.ip ?? "unknown").split(",")[0].trim();
}

@RequireModule("build")
@Controller("build/:projectId/whiteboards/:whiteboardId")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class WhiteboardSharingController {
  constructor(private readonly sharing: WhiteboardSharingService) {}

  @Patch("sharing")
  @RequirePermission("build:whiteboards:manage")
  updateSharing(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("whiteboardId", ParseIntPipe) whiteboardId: number,
    @Body(new ZodValidationPipe(updateWhiteboardSharingSchema)) body: UpdateWhiteboardSharingInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sharing.updateSharing(u, projectId, whiteboardId, body);
  }

  @Post("sharing/rotate-token")
  @RequirePermission("build:whiteboards:manage")
  @HttpCode(200)
  rotateShareToken(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("whiteboardId", ParseIntPipe) whiteboardId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sharing.rotateShareToken(u, projectId, whiteboardId);
  }

  @Put("shares")
  @RequirePermission("build:whiteboards:manage")
  setShares(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("whiteboardId", ParseIntPipe) whiteboardId: number,
    @Body(new ZodValidationPipe(setWhiteboardSharesSchema)) body: SetWhiteboardSharesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sharing.setShares(u, projectId, whiteboardId, body);
  }

  @Delete("shares/:targetUserId")
  @RequirePermission("build:whiteboards:manage")
  @HttpCode(204)
  removeShare(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("whiteboardId", ParseIntPipe) whiteboardId: number,
    @Param("targetUserId") targetUserId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sharing.removeShare(u, projectId, whiteboardId, targetUserId);
  }
}

@Public()
@Controller("public/whiteboard-links")
export class PublicWhiteboardLinksController {
  constructor(
    private readonly sharing: WhiteboardSharingService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Get(":token")
  async getByToken(@Param("token") token: string, @Req() req: Request) {
    const rl = await this.rateLimit.check("whiteboard:public-view", clientIp(req));
    if (!rl.allowed) {
      throw new HttpException(
        `Rate limited. Retry after ${rl.retryAfterSecs}s`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return this.sharing.getPublicByToken(token);
  }

  @Patch(":token")
  async updateByToken(
    @Param("token") token: string,
    @Body(new ZodValidationPipe(publicWhiteboardUpdateSchema)) body: PublicWhiteboardUpdateInput,
    @Req() req: Request,
  ) {
    const rl = await this.rateLimit.check("whiteboard:public-edit", clientIp(req));
    if (!rl.allowed) {
      throw new HttpException(
        `Rate limited. Retry after ${rl.retryAfterSecs}s`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return this.sharing.updatePublicByToken(token, body.data);
  }
}
