import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { IdempotencyKey } from "../../../common/idempotency/idempotency-key.decorator";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { PickWaveService } from "./pick-wave.service";
import { PickConfirmService } from "./pick-confirm.service";
import { PickExceptionReportService } from "./pick-exception-report.service";
import {
  confirmPickSchema,
  createWaveSchema,
  listWavesSchema,
  reassignWaveSchema,
  reportPlainPickExceptionSchema,
  substitutePickLineSchema,
  type ConfirmPickInput,
  type CreateWaveInput,
  type ListWavesInput,
  type ReassignWaveInput,
  type ReportPlainPickExceptionInput,
  type SubstitutePickLineInput,
} from "./dto/picking.schemas";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";

@RequireModule("inventory")
@Controller("inventory/picking")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class PickWaveController {
  constructor(
    private readonly waves: PickWaveService,
    private readonly picks: PickConfirmService,
    private readonly exceptions: PickExceptionReportService,
  ) {}

  @Post("waves")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:sales-orders:ship")
  @Idempotent("inventory.picking.wave.create")
  createWave(
    @Body(new ZodValidationPipe(createWaveSchema)) body: CreateWaveInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.waves.createWave(u.orgId, u.userId, body);
  }

  /**
   * NEO-14 - would these orders join a wave that is already open?
   *
   * A question, not a command: it reads and returns a decision, and the caller
   * then either posts to the join route or raises a new wave. A `createWave`
   * that silently appended to somebody else's wave would be exactly the surprise
   * this setting is hedged about, so the two acts stay separate at the API too.
   */
  @Post("waves/propose-join")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:sales-orders:ship")
  proposeJoin(
    @Body(new ZodValidationPipe(createWaveSchema)) body: CreateWaveInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.waves.proposeWaveJoin(u.orgId, u.userId, body);
  }

  /**
   * NEO-14 — the join route the comment above has always pointed at.
   *
   * It did not exist, so the proposal was a decision with nothing to act on and
   * no wave had ever been joined. The gate is re-applied in the service against
   * this wave as it stands now, not against the proposal: a picker can claim a
   * wave and confirm a line between the two calls, and that is exactly the case
   * `waveless.ts` refuses.
   */
  @Post("waves/:pickListId/join")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:sales-orders:ship")
  joinWave(
    @Param("pickListId", ParseIntPipe) pickListId: number,
    @Body(new ZodValidationPipe(createWaveSchema)) body: CreateWaveInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.waves.joinWave(u.orgId, u.userId, pickListId, body);
  }

  /** B4, item 5. The workbench queue: waves waiting, and waves this picker holds. */
  @Get("waves")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:sales-orders:read")
  listWaves(
    @Query(new ZodValidationPipe(listWavesSchema)) query: ListWavesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.waves.listWaves(u.orgId, u.userId, query);
  }

  @Get("waves/:pickListId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:sales-orders:read")
  getWave(
    @Param("pickListId", ParseIntPipe) pickListId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.waves.getWave(u.orgId, u.userId, pickListId);
  }

  /**
   * B4, item 3. Claim, abandon and reassign take no idempotency key on purpose:
   * each is a single conditional update against the current assignment, so a
   * repeat is the same state rather than a second effect. A key would imply a
   * fence these do not need, and an unused key is worse than none because the
   * client believes it is protected.
   */
  @Post("waves/:pickListId/claim")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:sales-orders:ship")
  @Idempotent("inventory.picking.wave.claim")
  claimWave(
    @Param("pickListId", ParseIntPipe) pickListId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.waves.claimWave(u.orgId, u.userId, pickListId);
  }

  @Post("waves/:pickListId/abandon")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:sales-orders:ship")
  abandonWave(
    @Param("pickListId", ParseIntPipe) pickListId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.waves.abandonWave(u.orgId, u.userId, pickListId);
  }

  @Post("waves/:pickListId/reassign")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:sales-orders:ship")
  @Idempotent("inventory.picking.wave.reassign")
  reassignWave(
    @Param("pickListId", ParseIntPipe) pickListId: number,
    @Body(new ZodValidationPipe(reassignWaveSchema)) body: ReassignWaveInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.waves.reassignWave(u.orgId, u.userId, pickListId, body);
  }

  @Post("waves/:pickListId/confirm")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:sales-orders:ship")
  confirmPick(
    @IdempotencyKey() idempotencyKey: string,
    @Param("pickListId", ParseIntPipe) pickListId: number,
    @Body(new ZodValidationPipe(confirmPickSchema)) body: ConfirmPickInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.picks.confirmPick(u.orgId, u.userId, pickListId, body, idempotencyKey);
  }

  /**
   * INV-205 / B5. Records why a line could not close as asked, which is also what
   * lets a short-picked wave finish -- a picker holding a tote the system will
   * not let them close is exactly the situation this resolves.
   *
   * `SUBSTITUTED` cannot come through here; it has its own route below.
   * `PermissionGuard` reads exactly one `@RequirePermission` per handler, so a
   * route covering every reason could only be gated at the weakest of them, and
   * a picker allowed to say "the bin was empty" would thereby be allowed to
   * change what the customer is owed.
   */
  @Post("waves/:pickListId/exception")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:sales-orders:ship")
  reportException(
    @IdempotencyKey() idempotencyKey: string,
    @Param("pickListId", ParseIntPipe) pickListId: number,
    @Body(new ZodValidationPipe(reportPlainPickExceptionSchema))
    body: ReportPlainPickExceptionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.exceptions.reportException(u.orgId, u.userId, pickListId, body, idempotencyKey);
  }

  /**
   * B5, item 3. Swapping a different SKU in at the shelf.
   *
   * Its own route because it is its own authority: this rewrites the sales-order
   * line's identity and moves the reservation onto the replacement, which is a
   * change to what the customer receives rather than a report about what the
   * shelf held.
   */
  @Post("waves/:pickListId/substitute")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:picking:substitute")
  substitutePickLine(
    @IdempotencyKey() idempotencyKey: string,
    @Param("pickListId", ParseIntPipe) pickListId: number,
    @Body(new ZodValidationPipe(substitutePickLineSchema)) body: SubstitutePickLineInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.exceptions.reportException(
      u.orgId,
      u.userId,
      pickListId,
      { ...body, reason: "SUBSTITUTED" },
      idempotencyKey,
    );
  }
}
