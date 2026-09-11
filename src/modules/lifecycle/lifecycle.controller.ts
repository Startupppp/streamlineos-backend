import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { LifecycleService } from "./lifecycle.service";
import {
  closeLifecycleSchema,
  listLifecyclesQuerySchema,
  recordSignalSchema,
  renewLifecycleSchema,
  type CloseLifecycleInput,
  type ListLifecyclesQuery,
  type RecordSignalInput,
  type RenewLifecycleInput,
} from "./dto/lifecycle.schemas";
import { ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import {
  listLifecyclesResponseSchema,
  getLifecycleResponseSchema,
  recordLifecycleSignalResponseSchema,
  renewLifecycleResponseSchema,
  closeLifecycleResponseSchema,
} from "./dto/lifecycle-response.schemas";

/**
 * The renewal book, as a surface.
 *
 * There is no route that creates a lifecycle. A term exists because a deal was
 * won, and a second way to mint one would let the book and the pipeline
 * disagree about what was sold — which is the failure this whole feature exists
 * to prevent, arriving from inside. The only door in is the closed-won hook in
 * `deals.service.ts`.
 *
 * The keys are written out as literals at each gate rather than hoisted into a
 * `VIEW`/`MANAGE` constant. `gated-keys-are-catalogued.spec.ts` reads the
 * decorators with a regex and cannot resolve a constant, so a gate expressed
 * that way is one the catalogue check silently does not cover — which is the
 * exact failure that spec exists for.
 *
 * Two keys, not one. Reading who is up for renewal and how exposed the revenue
 * is belongs to anybody planning a quarter; recording that a customer renewed,
 * churned, or is now worth a different number changes what the company believes
 * about its own recurring revenue, and that is a different authority to hand
 * out. Folding them together would make the second unavoidable to grant.
 */
@RequireModule("crm")
@Controller("crm/lifecycles")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class LifecycleController {
  constructor(private readonly lifecycle: LifecycleService) {}

  /**
   * The book. Ordered by renewal date by default rather than by risk, because
   * the planning question ("what is coming up") is the one asked most often and
   * the triage question is a filter away.
   */
  @Get()
  @RequirePermission("crm:lifecycle:view")
  @ResponseSchema(listLifecyclesResponseSchema)
  list(
    @Query(new ZodValidationPipe(listLifecyclesQuerySchema)) query: ListLifecyclesQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.lifecycle.list(u.orgId, query);
  }

  /** One contract with the evidence behind its score, so the number is arguable. */
  @Get(":customerLifecycleId")
  @RequirePermission("crm:lifecycle:view")
  @ResponseSchema(getLifecycleResponseSchema)
  get(
    @Param("customerLifecycleId") customerLifecycleId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.lifecycle.get(u.orgId, customerLifecycleId);
  }

  /**
   * Files evidence. Gated on `manage` rather than `view` because a signal moves
   * the score, and a score is what decides whose renewal gets attention this
   * week — somebody who may read the book must not be able to reorder it.
   */
  @Post(":customerLifecycleId/signals")
  @RequirePermission("crm:lifecycle:manage")
  @ResponseSchema(recordLifecycleSignalResponseSchema)
  recordSignal(
    @Param("customerLifecycleId") customerLifecycleId: string,
    @Body(new ZodValidationPipe(recordSignalSchema)) body: RecordSignalInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.lifecycle.recordSignal(u.orgId, customerLifecycleId, body, u.userId);
  }

  /**
   * Advances the term. Not `@Idempotent`: the service guards a double submission
   * in the database instead, by re-asserting the renewal count in the UPDATE's
   * WHERE — which also covers two different people confirming the same renewal
   * from two sessions, where a per-request idempotency key would not.
   */
  @Post(":customerLifecycleId/renew")
  @RequirePermission("crm:lifecycle:manage")
  @ResponseSchema(renewLifecycleResponseSchema)
  renew(
    @Param("customerLifecycleId") customerLifecycleId: string,
    @Body(new ZodValidationPipe(renewLifecycleSchema)) body: RenewLifecycleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.lifecycle.renew(u.orgId, customerLifecycleId, body, u.userId);
  }

  /** Ends it, with a stated reason. There is deliberately no route back to active. */
  @Post(":customerLifecycleId/close")
  @RequirePermission("crm:lifecycle:manage")
  @ResponseSchema(closeLifecycleResponseSchema)
  close(
    @Param("customerLifecycleId") customerLifecycleId: string,
    @Body(new ZodValidationPipe(closeLifecycleSchema)) body: CloseLifecycleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.lifecycle.close(u.orgId, customerLifecycleId, body);
  }
}
