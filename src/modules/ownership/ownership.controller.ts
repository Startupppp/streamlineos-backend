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
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { assertOwnerOnly } from "../../common/rbac/owner-only-operations";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { RateLimitGuard } from "../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../common/ratelimit/use-rate-limit.decorator";
import { OwnershipService } from "./ownership.service";
import { OwnershipTransfersService } from "./ownership-transfers.service";
import { OwnershipTransferResponseService } from "./ownership-transfer-response.service";
import {
  declineTransferSchema,
  initiateModuleTransferSchema,
  initiateOrgTransferSchema,
  listTransfersSchema,
  setModuleOwnerSchema,
  type DeclineTransferInput,
  type InitiateModuleTransferInput,
  type InitiateOrgTransferInput,
  type ListTransfersInput,
  type SetModuleOwnerInput,
} from "./dto/ownership.schemas";
import { Validate } from "../../common/validation/validate.decorator";
import { z } from "zod";

const moduleKeyParams = z.object({ moduleKey: z.string().min(1) }).strict();
const transferIdParams = z.object({ transferId: z.string().min(1) }).strict();

@Controller("ownership")
@UseGuards(JwtAuthGuard)
export class OwnershipController {
  constructor(
    private readonly ownership: OwnershipService,
    private readonly transfers: OwnershipTransfersService,
    private readonly responses: OwnershipTransferResponseService,
  ) {}

  @Get("modules")
  @UseGuards(PermissionGuard)
  @RequirePermission("ownership:modules:view")
  listModuleOwnerships(@CurrentUser() u: CurrentUserContext) {
    return this.ownership.listModuleOwnerships(u.orgId);
  }

  @Get("modules/:moduleKey")
  @UseGuards(PermissionGuard)
  @RequirePermission("ownership:modules:view")
  @Validate({ params: moduleKeyParams })
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
  @Validate({ params: moduleKeyParams })
  forceSetModuleOwner(
    @Param("moduleKey") moduleKey: string,
    @Body(new ZodValidationPipe(setModuleOwnerSchema)) body: SetModuleOwnerInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    assertOwnerOnly(u, "organization.ownership.force-set-module-owner");
    return this.ownership.forceSetModuleOwner(u.orgId, u.userId, moduleKey, body);
  }

  @Post("org/transfer")
  @Idempotent("ownership.org-transfer.initiate")
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(PermissionGuard, RateLimitGuard)
  @RequirePermission("ownership:org:transfer")
  @UseRateLimit("ownership:transfer")
  initiateOrgTransfer(
    @Body(new ZodValidationPipe(initiateOrgTransferSchema)) body: InitiateOrgTransferInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    assertOwnerOnly(u, "organization.ownership.transfer");
    return this.transfers.initiateOrgTransfer(u.orgId, u.userId, body);
  }

  @Post("modules/:moduleKey/transfer")
  @Idempotent("ownership.module-transfer.initiate")
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(PermissionGuard, RateLimitGuard)
  @RequirePermission("ownership:modules:manage")
  @UseRateLimit("ownership:transfer")
  @Validate({ params: moduleKeyParams })
  initiateModuleTransfer(
    @Param("moduleKey") moduleKey: string,
    @Body(new ZodValidationPipe(initiateModuleTransferSchema)) body: InitiateModuleTransferInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.transfers.initiateModuleTransfer(
      u.orgId,
      u.userId,
      moduleKey,
      body,
      u,
    );
  }

  @Get("transfers/incoming")
  @UseGuards(PermissionGuard)
  @RequirePermission("ownership:transfer:respond")
  listIncomingTransfers(@CurrentUser() u: CurrentUserContext) {
    return this.transfers.listIncomingTransfers(u.orgId, u.userId);
  }

  @Get("transfers")
  @UseGuards(PermissionGuard)
  @RequirePermission("ownership:modules:view")
  listTransfers(
    @Query(new ZodValidationPipe(listTransfersSchema)) query: ListTransfersInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.transfers.listTransfers(u.orgId, query);
  }

  @Post("transfers/:transferId/accept")
  @Idempotent("ownership.transfer.accept")
  @HttpCode(HttpStatus.OK)
  @UseGuards(PermissionGuard, RateLimitGuard)
  @RequirePermission("ownership:transfer:respond")
  @UseRateLimit("ownership:transfer")
  @Validate({ params: transferIdParams })
  acceptTransfer(
    @Param("transferId") transferId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.responses.acceptTransfer(u.orgId, u.userId, transferId);
  }

  @Post("transfers/:transferId/decline")
  @Idempotent("ownership.transfer.decline")
  @HttpCode(HttpStatus.OK)
  @UseGuards(PermissionGuard, RateLimitGuard)
  @RequirePermission("ownership:transfer:respond")
  @UseRateLimit("ownership:transfer")
  @Validate({ params: transferIdParams })
  declineTransfer(
    @Param("transferId") transferId: string,
    @Body(new ZodValidationPipe(declineTransferSchema)) body: DeclineTransferInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.responses.declineTransfer(u.orgId, u.userId, transferId, body);
  }

  @Delete("transfers/:transferId")
  @Idempotent("ownership.transfer.cancel")
  @HttpCode(HttpStatus.OK)
  @UseGuards(PermissionGuard, RateLimitGuard)
  @RequirePermission("ownership:modules:manage")
  @UseRateLimit("ownership:transfer")
  @Validate({ params: transferIdParams })
  cancelTransfer(
    @Param("transferId") transferId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.responses.cancelTransfer(
      u.orgId,
      u.userId,
      transferId,
      u,
    );
  }
}
