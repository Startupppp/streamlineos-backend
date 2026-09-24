import { Body, Controller, Get, Param, ParseIntPipe, Post, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../../access/permission.guard";
import { RequirePermission } from "../../../access/require-permission.decorator";
import { RequireModule } from "../../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { Validate } from "../../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../../common/openapi/zod-operation-contracts";
import { Idempotent } from "../../../../common/idempotency/idempotent.decorator";
import { BgvService } from "./bgv.service";
import { BGV_CHECK_TYPES } from "./bgv-provider";
import { BGV_STATUSES } from "./bgv-status";

const candidateIdParams = z.object({ candidateId: z.coerce.number().int().positive() }).strict();

const initiateBgvSchema = z
  .object({ checks: z.array(z.enum(BGV_CHECK_TYPES)).min(1).max(BGV_CHECK_TYPES.length) })
  .strict();
type InitiateBgvInput = z.infer<typeof initiateBgvSchema>;

/**
 * A recruiter's own record of a check they ran.
 *
 * `source` is not a field here. It is fixed to `MANUAL` by the handler, because
 * the whole point of the column is that this endpoint cannot produce an agency
 * verdict — a client that could pass `AGENCY` would make the distinction
 * decorative.
 */
const recordBgvSchema = z
  .object({
    status: z.enum(BGV_STATUSES),
    agency: z.string().trim().max(200).optional(),
    notes: z.string().trim().max(2000).optional(),
  })
  .strict();
type RecordBgvInput = z.infer<typeof recordBgvSchema>;

const bgvViewSchema = z.object({
  candidateId: z.number().int(),
  status: z.enum(BGV_STATUSES),
  source: z.enum(["MANUAL", "AGENCY"]).nullable(),
  agency: z.string().nullable(),
  reference: z.string().nullable(),
  notes: z.string().nullable(),
  initiatedAt: z.date().nullable(),
  completedAt: z.date().nullable(),
  summary: z.string(),
  agencyCleared: z.boolean(),
  providerBlockedReason: z.string().nullable(),
});

@RequireModule("hr")
@Controller("hr/recruitment/candidates/:candidateId/bgv")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class BgvController {
  constructor(private readonly bgv: BgvService) {}

  @Get()
  @ResponseSchema(bgvViewSchema)
  @RequirePermission("hr:requisitions:view")
  @Validate({ params: candidateIdParams })
  read(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.bgv.read(u.orgId, candidateId);
  }

  /**
   * Opens a case with the connected agency, or explains why it cannot.
   *
   * Idempotency-keyed because opening a case costs money and a double-submit
   * would buy the same check twice.
   */
  @Post("initiate")
  @Idempotent("hr.recruitment.bgv.initiate")
  @ResponseSchema(bgvViewSchema)
  @RequirePermission("hr:requisitions:manage")
  @Validate({ params: candidateIdParams, body: initiateBgvSchema })
  initiate(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Body() body: InitiateBgvInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.bgv.initiate(u.orgId, { userId: u.userId }, candidateId, body.checks);
  }

  @Post("record")
  @ResponseSchema(bgvViewSchema)
  @RequirePermission("hr:requisitions:manage")
  @Validate({ params: candidateIdParams, body: recordBgvSchema })
  record(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Body() body: RecordBgvInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.bgv.recordVerdict(u.orgId, { userId: u.userId }, candidateId, {
      status: body.status,
      source: "MANUAL",
      agency: body.agency,
      notes: body.notes,
    });
  }
}
