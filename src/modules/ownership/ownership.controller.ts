import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { RateLimitGuard } from "../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../common/ratelimit/use-rate-limit.decorator";
import { OwnershipService } from "./ownership.service";
import {
  declineTransferSchema,
  forceTransferOrgSchema,
  initiateModuleTransferSchema,
  initiateOrgTransferSchema,
  listTransfersSchema,
  setModuleOwnerSchema,
  type DeclineTransferInput,
  type ForceTransferOrgInput,
  type InitiateModuleTransferInput,
  type InitiateOrgTransferInput,
  type ListTransfersInput,
  type SetModuleOwnerInput,
} from "./dto/ownership.schemas";

@Controller("ownership")
@UseGuards(JwtAuthGuard)
export class OwnershipController {
  constructor(private readonly ownership: OwnershipService) {}

  @Get("modules")
  @UseGuards(PermissionGuard)
  @RequirePermission("ownership:modules:view")
  listModuleOwnerships(@CurrentUser() u: CurrentUserContext) {
    return this.ownership.listModuleOwnerships(u.orgId);
  }

  @Get("modules/:moduleKey")
  @UseGuards(PermissionGuard)
  @RequirePermission("ownership:modules:view")
  getModuleOwnership(
    @Param("moduleKey") moduleKey: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ownership.getModuleOwnership(u.orgId, moduleKey);
  }

  @Put("modules/:moduleKey/owner")
  @UseGuards(PermissionGuard, RateLimitGuard)
  @RequirePermission("ownership:modules:manage")
  @UseRateLimit("ownership:force-set")
  forceSetModuleOwner(
    @Param("moduleKey") moduleKey: string,
    @Body(new ZodValidationPipe(setModuleOwnerSchema)) body: SetModuleOwnerInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner) {
      throw new ForbiddenException("Only the org owner may force-set a module owner");
    }
    return this.ownership.forceSetModuleOwner(u.orgId, u.userId, moduleKey, body);
  }

  @Post("org/transfer")
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(PermissionGuard, RateLimitGuard)
  @RequirePermission("ownership:org:transfer")
  @UseRateLimit("ownership:transfer")
  initiateOrgTransfer(
    @Body(new ZodValidationPipe(initiateOrgTransferSchema)) body: InitiateOrgTransferInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner) {
      throw new ForbiddenException("Only the org owner may initiate an org ownership transfer");
    }
    return this.ownership.initiateOrgTransfer(u.orgId, u.userId, body);
  }

  @Put("org/owner")

  @Post("modules/:moduleKey/transfer")
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(PermissionGuard, RateLimitGuard)
  @RequirePermission("ownership:modules:manage")
  @UseRateLimit("ownership:transfer")
  initiateModuleTransfer(
    @Param("moduleKey") moduleKey: string,
    @Body(new ZodValidationPipe(initiateModuleTransferSchema)) body: InitiateModuleTransferInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ownership.initiateModuleTransfer(
      u.orgId,
      u.userId,
      moduleKey,
      body,
      u.isOrgOwner,
    );
  }

  @Get("transfers/incoming")
  @UseGuards(PermissionGuard)
  @RequirePermission("ownership:transfer:respond")
  listIncomingTransfers(@CurrentUser() u: CurrentUserContext) {
    return this.ownership.listIncomingTransfers(u.orgId, u.userId);
  }

  @Get("transfers")
  @UseGuards(PermissionGuard)
  @RequirePermission("ownership:modules:view")
  listTransfers(
    @Query(new ZodValidationPipe(listTransfersSchema)) query: ListTransfersInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ownership.listTransfers(u.orgId, query);
  }

  @Post("transfers/:transferId/accept")
  @HttpCode(HttpStatus.OK)
  @UseGuards(PermissionGuard, RateLimitGuard)
  @RequirePermission("ownership:transfer:respond")
  @UseRateLimit("ownership:transfer")
  acceptTransfer(
    @Param("transferId") transferId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ownership.acceptTransfer(u.orgId, u.userId, transferId);
  }

  @Post("transfers/:transferId/decline")
  @HttpCode(HttpStatus.OK)
  @UseGuards(PermissionGuard, RateLimitGuard)
  @RequirePermission("ownership:transfer:respond")
  @UseRateLimit("ownership:transfer")
  declineTransfer(
    @Param("transferId") transferId: string,
    @Body(new ZodValidationPipe(declineTransferSchema)) body: DeclineTransferInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ownership.declineTransfer(u.orgId, u.userId, transferId, body);
  }

  @Delete("transfers/:transferId")
  @HttpCode(HttpStatus.OK)
  @UseGuards(PermissionGuard, RateLimitGuard)
  @RequirePermission("ownership:modules:manage")
  @UseRateLimit("ownership:transfer")
  cancelTransfer(
    @Param("transferId") transferId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ownership.cancelTransfer(
      u.orgId,
      u.userId,
      transferId,
      u.isOrgOwner,
    );
  }
}
