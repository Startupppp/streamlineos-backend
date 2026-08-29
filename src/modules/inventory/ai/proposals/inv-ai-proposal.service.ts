import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { AccessService } from "../../../access/access.service";
import { AiGatewayService } from "../../../ai/core/gateway/ai-gateway.service";
import type { AiUsageMeta } from "../../../ai/core/gateway/ai-gateway.types";
import { AiConfirmationService } from "../../../ai/confirmation/ai-confirmation.service";
import { PoBatchService, type CreatedPoBatch } from "../../replenishment/forecast/po-batch.service";
import { ForecastPersistenceService } from "../../replenishment/forecast/forecast-persistence.service";
import { cmpDec } from "../../stock-engine/decimal";
import {
  INV_AI_CONTRACT_VERSION,
  invAiNarrativeResponseSchema,
} from "../dto/inv-ai-contract";
import {
  buildSystemPrompt,
  referencesFrom,
  toNarration,
  type InsightNarration,
} from "../inv-ai-narration";
import { assertInvAiConfirmAuthority } from "../inv-ai-confirm-authority";
import {
  evidenceFromProposal,
  hashProposalEvidence,
  type InvAiProposalEvidence,
  type InvAiProposalForecast,
} from "./inv-ai-proposal-evidence";
import type {
  InvAiConfirmProposalInput,
  InvAiProposalStatus,
  InvAiReorderProposalInput,
} from "./dto/inv-ai-proposal.schemas";

const FEATURE_KEY = "inv.reorder-explain" as const;
const PROMPT_KEY = "inv.reorder-explain" as const;
const PROMPT_VERSION = 2 as const;

/**
 * The action the stored proposal carries, and what
 * `inv-ai-confirm-authority.ts` prices at `ai:propose` **and**
 * `purchase-orders:create`. A literal, so the authority table and the proposal
 * cannot drift apart.
 */
const PROPOSAL_ACTION = "inventory:create-draft-po" as const;

/**
 * How long a reviewed proposal stays confirmable. Two minutes is not a security
 * boundary — the evidence hash is — it is a bound on how far the world can move
 * while a token sits in a browser tab.
 */
const PROPOSAL_TTL_SECONDS = 120;

export interface InvAiProposalResult {
  status: InvAiProposalStatus;
  /** Every figure the server computed. Never model output, never client input. */
  evidence: InvAiProposalEvidence;
  /** The C1 forecast behind the proposal, including what it was unsure about. */
  forecast: InvAiProposalForecast;
  /** Present only when a proposal was actually made. */
  explanation: InsightNarration | null;
  /** Present only when a proposal was actually made. */
  proposal: { proposalId: number; token: string; expiresAt: Date } | null;
  /** Set on `blocked`: why the server would not propose. Server-authored. */
  blockedReason: string | null;
  aiUsage?: AiUsageMeta;
}

/**
 * What the stored payload holds. Read back defensively — it has been through
 * Postgres JSON, and a payload written by an older build must fail closed
 * rather than deserialise into a plausible-looking half.
 */
interface StoredProposalPayload {
  evidence: InvAiProposalEvidence;
  evidenceHash: string;
}

function readStoredPayload(payload: Record<string, unknown>): StoredProposalPayload {
  const evidence = payload["evidence"];
  const evidenceHash = payload["evidenceHash"];
  if (
    typeof evidenceHash !== "string" ||
    typeof evidence !== "object" ||
    evidence === null
  ) {
    // Not a 404 and not a 403: the token was valid and belongs to this caller,
    // but the thing it points at cannot be checked. An unverifiable proposal is
    // refused rather than executed on trust.
    throw new ConflictException(
      "This proposal was stored in a form this version cannot verify. Propose again.",
    );
  }
  const candidate = evidence as Partial<InvAiProposalEvidence>;
  if (
    typeof candidate.proposalId !== "number" ||
    typeof candidate.suggestedQuantity !== "string"
  ) {
    throw new ConflictException(
      "This proposal was stored in a form this version cannot verify. Propose again.",
    );
  }
  return {
    evidence: candidate as InvAiProposalEvidence,
    evidenceHash,
  };
}

/**
 * The prompt. Server-computed figures, labelled as exact, and nothing the model
 * is invited to recompute.
 *
 * The quantity is stated as already final — "the server will order this" rather
 * than "consider ordering this" — because a model told a number is provisional
 * will helpfully propose a better one, and a better number in a narration beside
 * a real one is the exact confusion this contract exists to prevent.
 */
function buildProposalUserPrompt(
  evidence: InvAiProposalEvidence,
  forecast: InvAiProposalForecast,
): string {
  return [
    "A replenishment proposal was computed by the inventory engine. These figures are final and exact; the quantity below is what will be ordered if the operator confirms.",
    "",
    "ORDER (computed by the server):",
    JSON.stringify(evidence, null, 2),
    "",
    "FORECAST BEHIND IT (C1 persisted version, including its own uncertainty):",
    JSON.stringify(forecast, null, 2),
    "",
    "Explain to a buyer why this order is warranted and what the forecast is and is not confident about. Put the server's figures in `factors` with isFactual: true, and any operational judgement of your own with isFactual: false. Do not restate the quantity as a recommendation of your own and do not propose a different one.",
  ].join("\n");
}

/**
 * F4 — an AI reorder proposal is a **persisted C2 proposal**, narrated.
 *
 * Three properties, and each is load-bearing:
 *
 * **The proposal already exists before the model is involved.** It is an
 * `inv_demand_forecasts` version resolved through `PoBatchService` — the same
 * resolution, the same reorder point, the same live position, the same
 * `applyOrderPolicy` rounding the buyer's own batching screen runs. The model
 * arrives after the number is decided and writes a paragraph about it.
 *
 * **Confirm re-evaluates rather than replays.** Quantity, vendor, permission
 * and the evidence hash are all recomputed against the live ledger at confirm
 * time. Nothing in the stored payload is trusted as a figure — it is trusted
 * only as *what was reviewed*, which is precisely what the comparison needs.
 *
 * **Nothing here writes stock.** The only mutation on this path is
 * `PoBatchService.create`, which raises a DRAFT purchase order and asserts
 * `inventory:purchase-orders:create` on its own side. A draft order is a
 * document, not a movement: no on-hand changes, no reservation is taken, no
 * hold is placed.
 */
@Injectable()
export class InvAiProposalService {
  constructor(
    private readonly gateway: AiGatewayService,
    private readonly confirmation: AiConfirmationService,
    private readonly access: AccessService,
    private readonly batches: PoBatchService,
    private readonly forecasts: ForecastPersistenceService,
  ) {}

  /**
   * Narrate the persisted proposal for this variant and site, and mint a
   * confirmable token for it.
   */
  async propose(
    user: CurrentUserContext,
    input: InvAiReorderProposalInput,
  ): Promise<InvAiProposalResult> {
    const { orgId, userId } = user;
    const warehouseId = input.warehouseId ?? null;

    // C1's stored version, not a fresh guess. `latest` is the newest version for
    // exactly this (variant, scope) pair; a proposal narrated against a forecast
    // recomputed on the fly would be a narrative about numbers nobody kept.
    const forecastVersion = await this.forecasts.latest(
      orgId,
      input.variantId,
      warehouseId,
    );
    if (!forecastVersion) {
      throw new NotFoundException(
        "No stored forecast exists for this item and site yet, so there is no proposal to review.",
      );
    }

    // C2's resolution of that version. Asserts warehouse visibility, reads the
    // live position, and puts the shortfall through the supplier's policy.
    const proposal = await this.batches.proposalById(
      orgId,
      userId,
      forecastVersion.id,
    );
    if (!proposal) {
      throw new NotFoundException("This proposal no longer exists.");
    }

    const evidence = evidenceFromProposal(proposal);
    const forecast: InvAiProposalForecast = {
      method: forecastVersion.method,
      demandCategory: forecastVersion.demandCategory,
      applicable: forecastVersion.applicable,
      refusalReason: forecastVersion.refusalReason,
      serviceLevel: forecastVersion.serviceLevel,
      safetyStock: forecastVersion.safetyStock,
      demandMean: forecastVersion.demand.mean,
      demandStdDev: forecastVersion.demand.stdDev,
      leadTimeWeeks: forecastVersion.leadTime.weeks,
      leadTimeStdDevWeeks: forecastVersion.leadTime.stdDevWeeks,
      mase: forecastVersion.metrics?.mase ?? null,
      stockoutCensored: forecastVersion.stockoutCensored,
    };

    // Denial of wallet, and honesty. A blocked proposal cannot be confirmed, so
    // narrating one buys a paragraph about an order that will never exist. The
    // reason is the server's own sentence from `blockedReason`, not the model's.
    if (evidence.blockedReason !== null) {
      return {
        status: "blocked",
        evidence,
        forecast,
        explanation: null,
        proposal: null,
        blockedReason: evidence.blockedReason,
      };
    }

    const result = await this.gateway.invokeStructuredWithUsage({
      actor: { orgId, userId },
      feature: FEATURE_KEY,
      tier: "fast",
      maxTokens: 512,
      charge: true,
      redact: false,
      schema: invAiNarrativeResponseSchema,
      prompt: {
        system: buildSystemPrompt(),
        user: buildProposalUserPrompt(evidence, forecast),
        promptKey: PROMPT_KEY,
        promptVersion: PROMPT_VERSION,
      },
    });

    if (!result.ok) {
      throw new ServiceUnavailableException(result.message);
    }

    const narration = toNarration(
      result.data,
      referencesFrom([
        ["reorder_suggestion", evidence.proposalId],
        ["product_variant", evidence.productVariantId],
        ["vendor", evidence.vendorId],
        ["warehouse", evidence.warehouseId],
      ]),
      { ...evidence, forecast } as unknown as Record<string, unknown>,
      {
        contractVersion: INV_AI_CONTRACT_VERSION,
        promptKey: PROMPT_KEY,
        promptVersion: PROMPT_VERSION,
        model: result.aiUsage.model,
        correlationId: result.correlationId,
      },
    );

    const stored = await this.confirmation.propose({
      orgId,
      userId,
      action: PROPOSAL_ACTION,
      // The evidence and its hash, and nothing derived from the narration. What
      // is stored is *what was reviewed*, so the confirm can ask whether the
      // world still agrees with it.
      payload: {
        evidence,
        evidenceHash: hashProposalEvidence(evidence),
      } as unknown as Record<string, unknown>,
      // Keyed on the position, not the clock. `propose` replays a live PROPOSED
      // row with a matching key, so every refresh of the screen reuses the one
      // proposal for this shortfall instead of minting another independently
      // confirmable one — confirming two of those raises two purchase orders.
      idempotencyKey: `ai-reorder:${orgId}:${evidence.proposalId}`,
      ttlSeconds: PROPOSAL_TTL_SECONDS,
    });

    return {
      status: "proposed",
      evidence,
      forecast,
      explanation: narration,
      proposal: stored,
      blockedReason: null,
      aiUsage: result.aiUsage,
    };
  }

  /**
   * Confirm a reviewed proposal into a draft purchase order.
   *
   * The permission assertion runs twice, deliberately. Once **before**
   * `confirm`, because `confirm` consumes the proposal — a denial after it
   * would leave the caller with a spent token, and repeated denials would be a
   * way to burn other people's proposals. And once **after**, against the action
   * the stored row actually carries, because the first check can only assert the
   * authority this *route* is about; a token minted for a transfer and replayed
   * here must be measured against a transfer's authority.
   *
   * Then the picture is re-evaluated. The specific checks come before the hash
   * so that the common failures name themselves — "the supplier changed",
   * "the quantity changed" — and the hash catches everything else, including
   * whatever material field somebody adds next.
   */
  async confirm(
    user: CurrentUserContext,
    input: InvAiConfirmProposalInput,
  ): Promise<CreatedPoBatch> {
    const { orgId, userId } = user;

    await assertInvAiConfirmAuthority(this.access, user, PROPOSAL_ACTION);

    const confirmed = await this.confirmation.confirm({
      token: input.token,
      actor: { orgId, userId },
    });

    if (confirmed.proposalId !== input.proposalId) {
      // The token carries its own id and the body carries one too. They must be
      // the same proposal, or the caller is confirming something other than what
      // they believe they are looking at.
      throw new ConflictException("This token belongs to a different proposal.");
    }

    if (confirmed.action !== PROPOSAL_ACTION) {
      await assertInvAiConfirmAuthority(this.access, user, confirmed.action);
      throw new ForbiddenException("This proposal is not a draft purchase order.");
    }

    const { evidence: reviewed, evidenceHash } = readStoredPayload(confirmed.payload);

    // Re-resolved, not replayed. Same service, same arithmetic, live position.
    const current = await this.batches.proposalById(
      orgId,
      userId,
      reviewed.proposalId,
    );
    if (!current) {
      throw new ConflictException(
        "The proposal behind this review no longer exists. Review the current figures and propose again.",
      );
    }
    const now = evidenceFromProposal(current);

    if (now.blockedReason !== null) {
      throw new ConflictException(
        `This can no longer be ordered: ${now.blockedReason}`,
      );
    }

    if (now.vendorId !== reviewed.vendorId) {
      throw new ConflictException(
        "The supplier for this item changed after the proposal was reviewed. Review the current figures and propose again.",
      );
    }

    // Exact decimal comparison. `"36.0000" !== "36"` is true as strings and
    // false as quantities, and a proposal refused because two spellings of the
    // same number disagreed is an alarm that teaches people to ignore alarms.
    if (cmpDec(now.suggestedQuantity, reviewed.suggestedQuantity) !== 0) {
      throw new ConflictException(
        "The quantity changed after this proposal was reviewed. Review the current figures and propose again.",
      );
    }

    if (hashProposalEvidence(now) !== evidenceHash) {
      throw new ConflictException(
        "The stock position changed after this proposal was made. Review the current figures and propose again.",
      );
    }

    if (now.vendorId === null) {
      // Unreachable while `blockedReason` covers a missing supplier, and kept
      // because the compiler cannot see that and because a future change to
      // `blockedReason` must not silently make a vendor-less order possible.
      throw new ConflictException(
        "No supplier is set for this item, so there is nobody to order it from.",
      );
    }

    // `create` asserts `inventory:purchase-orders:create` on its own side
    // (`assertMayCreatePurchaseOrder`) and recomputes the quantity itself. No
    // quantity crosses this call: `create` has no parameter for one.
    const created = await this.batches.create(
      orgId,
      userId,
      { proposalIds: [reviewed.proposalId], vendorId: now.vendorId },
      // Derived from the confirmed proposal, not minted per call: confirming the
      // same review twice must raise one purchase order.
      `ai-reorder-confirm:${confirmed.proposalId}`,
    );

    await this.confirmation.markExecuted(
      confirmed.proposalId,
      { poId: created.poId, poNumber: created.poNumber },
      orgId,
    );

    return created;
  }
}
