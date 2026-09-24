import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { organizations } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import { ProviderCredentialsService } from "../integrations/provider-credentials.service";
import { verifyVendorSignature } from "../integrations/vendor-signature";
import { BGV_PLATFORM } from "./bgv-provider";
import { BgvService } from "./bgv.service";
import type { BgvStatus } from "./bgv-status";

/**
 * What an agency may tell us, and nothing more.
 *
 * `.strict()` so a vendor that starts sending extra fields is refused rather
 * than having them silently ignored — an unrecognised field in a verification
 * report is a change worth noticing, not swallowing.
 *
 * The status vocabulary is ours, not theirs. Mapping happens here, at the door,
 * so an agency's private spelling of "clear" never reaches the column.
 */
const agencyVerdictSchema = z
  .object({
    reference: z.string().trim().min(1).max(200),
    outcome: z.enum(["IN_PROGRESS", "CLEAR", "DISCREPANCY", "INSUFFICIENT"]),
    summary: z.string().trim().max(2000).optional(),
  })
  .strict();

export type AgencyVerdictInput = z.infer<typeof agencyVerdictSchema>;

/**
 * Two of the three non-progress outcomes become FAILED.
 *
 * `INSUFFICIENT` — the agency could not complete the check — is deliberately
 * not CLEARED. A check that could not be finished is not a check that passed,
 * and the difference is the whole reason this mapping is written out rather
 * than inferred from a boolean.
 */
const OUTCOME_TO_STATUS: Record<AgencyVerdictInput["outcome"], BgvStatus> = {
  IN_PROGRESS: "PENDING",
  CLEAR: "CLEARED",
  DISCREPANCY: "FAILED",
  INSUFFICIENT: "FAILED",
};

export interface CallbackResult {
  /** True when this delivery repeated a verdict already recorded. */
  replay: boolean;
  status: BgvStatus;
}

@Injectable()
export class BgvCallbackService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly bgv: BgvService,
    private readonly credentials: ProviderCredentialsService,
  ) {}

  /**
   * Records a verdict an agency pushed to us.
   *
   * The signature is checked before the body is parsed, over the exact bytes
   * the agency sent. Everything after that runs inside the tenant transaction,
   * because `candidate_sources` and `candidates` are both behind RLS and a read
   * without the GUC dies `42501` — which on a public route surfaces as a 500
   * and reads like a bug in the agency's integration.
   */
  async receive(
    orgSlug: string,
    rawBody: Buffer | string,
    signature: string | undefined,
  ): Promise<CallbackResult> {
    const org = await this.db.query.organizations.findFirst({
      where: and(eq(organizations.slug, orgSlug), isNull(organizations.deletedAt)),
      columns: { id: true },
    });
    /*
      404 for an unknown slug, before any signature work. A slug is public and
      guessable; refusing it here leaks nothing that the careers site does not
      already, and it keeps an attacker from using response timing on the HMAC
      as an organisation oracle.
    */
    if (!org) throw new NotFoundException("Unknown organisation.");

    return runInTenantTransaction(
      this.db,
      async () => {
        const credentials = await this.credentials.forPlatform(org.id, BGV_PLATFORM);
        const secret =
          credentials && typeof credentials.meta.inboundSecret === "string"
            ? credentials.meta.inboundSecret
            : null;
        if (!secret) {
          throw new ForbiddenException("No callback secret is configured for this agency.");
        }
        if (!verifyVendorSignature(rawBody, secret, signature)) {
          throw new ForbiddenException("Signature did not match.");
        }

        const parsed = agencyVerdictSchema.parse(
          JSON.parse(typeof rawBody === "string" ? rawBody : rawBody.toString("utf8")),
        );

        const candidateId = await this.bgv.byReference(org.id, parsed.reference);
        /*
          404 rather than 400. A reference we do not hold is not necessarily the
          agency's mistake — a candidate may have been deleted, or the case
          re-opened — and answering 400 invites a vendor to stop retrying a
          delivery that a later fix would accept.
        */
        if (candidateId === null) {
          throw new NotFoundException("No candidate matches that case reference.");
        }

        const view = await this.bgv.read(org.id, candidateId);
        const target = OUTCOME_TO_STATUS[parsed.outcome];
        if (view.status === target && view.source === "AGENCY") {
          // A redelivery of a verdict already recorded. Nothing to write.
          return { replay: true, status: target };
        }

        const updated = await this.bgv.recordVerdict(
          org.id,
          { systemActor: "bgv-agency-callback" },
          candidateId,
          {
            status: target,
            source: "AGENCY",
            reference: parsed.reference,
            notes: parsed.summary ?? null,
          },
        );
        return { replay: false, status: updated.status };
      },
      { orgId: org.id },
    );
  }
}
