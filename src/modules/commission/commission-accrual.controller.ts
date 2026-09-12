import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import { readRequestScope } from "../organization/core/read-request-scope";
import { CommissionAccrualService } from "./commission-accrual.service";
import {
  accrualByDealQuerySchema,
  accrualCurveQuerySchema,
  accrualQuerySchema,
  rebuildAccrualSchema,
  type AccrualByDealQuery,
  type AccrualCurveQuery,
  type AccrualQuery,
  type RebuildAccrualInput,
} from "./dto/commission-accrual.schemas";
import { ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import {
  periodAccrualResponseSchema,
  accrualCurveResponseSchema,
  dealAccrualResponseSchema,
  earningDecompositionResponseSchema,
  rebuildAccrualResponseSchema,
} from "./dto/commission-accrual-response.schemas";

/**
 * Reading an accrual, at four granularities that are the same number.
 *
 * A period, a deal, an earning, a day on the curve — each route returns a
 * figure and the parts that produced it, and the parts are integer sums of the
 * same ledger rows the figure is. That is the ticket, and it is why there are
 * four routes rather than one report: the question "why is my number this?"
 * gets asked from whichever end the asker is standing at.
 *
 * **Gating.** Every read here is gated on `crm:commission-earnings:view` —
 * deliberately the same key as the earnings ledger, not a new one. An accrual
 * *is* a set of earnings summed; a key that granted the total while withholding
 * the parts would be a permission to see a number nobody could check, which
 * inverts the point of the module. Reusing the key also inherits its scoping for
 * free: it is already `scopable`, already `own` for CRM members, and already the
 * key `access.service.ts` narrows, so a rep sees their accrual and a manager at
 * scope `all` sees the team's — with no second scope rule to keep in step with
 * the first.
 *
 * The rebuild is the exception and has its own key. It is a write: it deletes
 * and rewrites ledger rows and moves the curve. Whoever may read what they are
 * owed is emphatically not therefore entitled to rewrite the record of it.
 */
@RequireModule("crm")
@Controller("crm/commission/accrual")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class CommissionAccrualController {
  constructor(private readonly service: CommissionAccrualService) {}

  /**
   * The accrued figure for the period containing `on`, fully decomposed.
   *
   * The month-end review, available on the 3rd.
   */
  @Get()
  @RequirePermission("crm:commission-earnings:view")
  @ResponseSchema(periodAccrualResponseSchema)
  periodAccrual(
    @Query(new ZodValidationPipe(accrualQuerySchema)) query: AccrualQuery,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    return this.service.periodAccrual(u.orgId, query, this.viewer(u, req));
  }

  /** What the figure stood at on each day of the period. */
  @Get("curve")
  @RequirePermission("crm:commission-earnings:view")
  @ResponseSchema(accrualCurveResponseSchema)
  curve(
    @Query(new ZodValidationPipe(accrualCurveQuerySchema)) query: AccrualCurveQuery,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    return this.service.curve(u.orgId, query, this.viewer(u, req));
  }

  /** What one deal paid, to whom, under which band of which version. */
  @Get("by-deal")
  @RequirePermission("crm:commission-earnings:view")
  @ResponseSchema(dealAccrualResponseSchema)
  byDeal(
    @Query(new ZodValidationPipe(accrualByDealQuerySchema)) query: AccrualByDealQuery,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    return this.service.byDeal(u.orgId, query.dealId, this.viewer(u, req));
  }

  /** One earning taken apart, band by band. 404s for somebody else's. */
  @Get("earnings/:earningId")
  @RequirePermission("crm:commission-earnings:view")
  @ResponseSchema(earningDecompositionResponseSchema)
  decomposeEarning(
    @Param("earningId") earningId: string,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    return this.service.decomposeEarning(u.orgId, earningId, this.viewer(u, req));
  }

  /**
   * Re-derive the decomposition over a bounded date range.
   *
   * `@Idempotent` because a retried rebuild is a second delete-and-rewrite of
   * the same rows: harmless in its result and not harmless in its cost, and a
   * client that retried on a timeout would otherwise queue a duplicate
   * transaction behind one still holding the rows.
   *
   * Cannot change what anybody is paid — it apportions the stored total and
   * reports any earning whose total no longer reproduces rather than adjusting
   * it. See the service.
   */
  @Post("rebuild")
  @HttpCode(200)
  @RequirePermission("crm:commission-accruals:rebuild")
  @Idempotent("crm.commission.accrual.rebuild")
  @ResponseSchema(rebuildAccrualResponseSchema)
  rebuild(
    @Body(new ZodValidationPipe(rebuildAccrualSchema)) body: RebuildAccrualInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.rebuild(u.orgId, body);
  }

  /**
   * Whose rows this caller may read.
   *
   * Fail-closed: `readRequestScope` answers "none" when the guard did not run,
   * so a mis-wired route narrows to the caller rather than opening the ledger.
   * An accrual is compensation, and the safe failure is seeing too little.
   */
  private viewer(u: CurrentUserContext, req: Request) {
    return { userId: u.userId, viewAll: readRequestScope(req) === "all" };
  }
}
