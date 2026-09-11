import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { Validate } from "../../common/validation/validate.decorator";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import {
  consentRefusalSummary,
  RECORDING_CONSENT_RULE_VERSION,
  type CallConsentRefusal,
} from "./call-recording-consent";
import {
  CallRecordingConsentService,
  type CallConsentDecision,
} from "./call-recording-consent.service";
import { callAnalysisParamsSchema } from "./dto/call-analysis.schemas";
import {
  callRecordingConsentBodySchema,
  consentRefusalQuerySchema,
  type CallRecordingConsentBody,
  type ConsentRefusalQuery,
} from "./dto/call-recording-consent.schemas";
import { ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import {
  callRecordingConsentResponseSchema,
  consentRefusalsResponseSchema,
} from "./dto/call-recording-consent-response.schemas";

/**
 * Recording the evidence a two-party jurisdiction requires, and reading the
 * calls that had none.
 *
 * Three routes and no fourth. There is no route that skips the rule, no
 * `?force=true`, and no administrative override anywhere in this module. That
 * absence is the ticket: a two-party consent jurisdiction is a criminal-law
 * constraint on the product, and a constraint an administrator can switch off is
 * an advisory. `send-guardrails.ts` states the same thing for outbound and
 * `consent-is-not-a-setting.spec.ts` pins it for both.
 *
 * The attestation is gated on `crm:call-recording-consent:attest`, which stops
 * at the two CRM admin rungs and is deliberately not held by every rep. A rep is
 * the person who knows whether the recording notice was played — and also the
 * person the attestation benefits, because it is what unlocks the analysis of
 * their own call. A compliance assertion signed by its beneficiary is not
 * evidence of anything.
 *
 * `GET crm/calls/consent-refusals` has one path segment after the prefix and
 * `PUT crm/calls/:activityId/recording-consent` has two, so no ordering between
 * this controller and the two beside it on `crm/calls` can shadow either.
 */
@RequireModule("crm")
@Controller("crm/calls")
@UseGuards(JwtAuthGuard)
export class CallRecordingConsentController {
  constructor(private readonly consent: CallRecordingConsentService) {}

  /**
   * The calls this organisation is not analysing, and why.
   *
   * The reason this route exists at all: without it a refusal is
   * indistinguishable from a call nobody thought to analyse. Both render as an
   * empty panel, and a team whose jurisdiction field is never filled in would
   * conclude the feature is broken rather than that they are missing a
   * compliance record. This is how "we are refusing four hundred calls a month
   * for want of a jurisdiction" becomes something somebody can see and fix.
   *
   * It returns no transcript, no quote and no analysis. The refusal exists
   * precisely because none of that may be produced, and a ledger that quoted the
   * call to explain why the call could not be quoted would be the disclosure the
   * refusal prevented.
   */
  @Get("consent-refusals")
  @UseGuards(PermissionGuard)
  // The literal rather than a constant: `gated-keys-are-catalogued.spec.ts`
  // reads these decorators with a regex, and a gate expressed as an identifier
  // is a gate that scan stops covering.
  @RequirePermission("crm:call-recording-consent:attest")
  @ResponseSchema(consentRefusalsResponseSchema)
  @Validate({ query: consentRefusalQuerySchema })
  async refusals(
    @CurrentUser() user: CurrentUserContext,
    @Query() query: ConsentRefusalQuery,
  ) {
    const rows = await this.consent.refusals(user.orgId, query.sinceDays, query.limit);

    return {
      data: rows.map((row) => ({
        ...row,
        summary: consentRefusalSummary(row.reason as CallConsentRefusal),
      })),
      meta: {
        sinceDays: query.sinceDays,
        ruleVersion: RECORDING_CONSENT_RULE_VERSION,
        /**
         * Stated on every response, not only when something is refused. A team
         * reading an empty ledger should learn that the rule failing closed is
         * the design rather than assuming nothing is being blocked.
         */
        defaultRegime: "two-party",
      },
    };
  }

  /**
   * Whether this call may be analysed, and what is missing if it may not.
   *
   * Gated on `crm:call-analysis:view` — the key every CRM member holds — rather
   * than on the attest key. Whether a call is analysable is not itself sensitive
   * (it carries no content), and a rep who cannot find out why their call has no
   * analysis will file a bug instead of asking somebody to attest.
   */
  @Get(":activityId/recording-consent")
  @UseGuards(PermissionGuard)
  @RequirePermission("crm:call-analysis:view")
  @ResponseSchema(callRecordingConsentResponseSchema)
  @Validate({ params: callAnalysisParamsSchema })
  async read(
    @CurrentUser() user: CurrentUserContext,
    @Param("activityId") activityId: string,
  ) {
    return { data: wire(await this.consent.decide(user.orgId, activityId)) };
  }

  /**
   * Attest to where the call happened and who agreed to it being recorded.
   *
   * `PUT` rather than `POST`, because the first attestation is usually
   * incomplete — somebody records the jurisdiction when the call lands and the
   * consent evidence once they have checked it — and a create-only route would
   * make the second half unreachable. The body is the whole state of the
   * attestation for that reason: a partial `PATCH` would let "the customer
   * consented" survive an edit that was meant to remove it.
   *
   * Idempotent by the unique index on (organisation, call), so two people
   * attesting at once leave one row rather than a question about which is real.
   */
  @Put(":activityId/recording-consent")
  @UseGuards(PermissionGuard)
  @RequirePermission("crm:call-recording-consent:attest")
  @HttpCode(200)
  @ResponseSchema(callRecordingConsentResponseSchema)
  @Validate({ params: callAnalysisParamsSchema, body: callRecordingConsentBodySchema })
  async attest(
    @CurrentUser() user: CurrentUserContext,
    @Param("activityId") activityId: string,
    @Body() body: CallRecordingConsentBody,
  ) {
    const outcome = await this.consent.attest(user.orgId, user.userId, activityId, {
      jurisdiction: body.jurisdiction,
      orgPartyConsented: body.orgPartyConsented,
      counterpartyConsented: body.counterpartyConsented,
      counterpartyMethod: body.counterpartyMethod ?? null,
      counterpartyWithdrawn: body.counterpartyWithdrawn,
      note: body.note ?? null,
    });

    if (!outcome.ok) {
      if (outcome.reason === "not-found") throw new NotFoundException(outcome.note);
      throw new BadRequestException(outcome.note);
    }

    /**
     * The decision is returned rather than a bare 200, so the attester finds out
     * immediately whether what they recorded is enough. An attestation that
     * silently still refuses — the customer's consent dated after the call, our
     * own side left unticked — would otherwise look like it worked and be
     * discovered when somebody wonders why the analysis never appeared.
     */
    return { data: wire(outcome.decision) };
  }
}

/** The decision as a client sees it. Never carries the analysis it governs. */
function wire(decision: CallConsentDecision) {
  const verdict = decision.verdict;
  return {
    activityId: decision.activityId,
    allowed: verdict.allowed,
    regime: verdict.regime,
    jurisdiction: verdict.jurisdiction,
    basis: decision.basis,
    ruleVersion: verdict.ruleVersion,
    reason: verdict.allowed ? null : verdict.reason,
    note: verdict.allowed ? null : verdict.note,
  };
}
