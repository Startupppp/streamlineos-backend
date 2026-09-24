import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { candidates } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { AuditService } from "../../../../common/audit/audit.service";
import { ProviderCredentialsService } from "../integrations/provider-credentials.service";
import { BGV_PLATFORM, resolveBgv, type BgvCheckType } from "./bgv-provider";
import {
  decideVerdict,
  describeBgv,
  isAgencyClearance,
  type BgvSource,
  type BgvStatus,
} from "./bgv-status";

export interface BgvView {
  candidateId: number;
  status: BgvStatus;
  source: BgvSource | null;
  agency: string | null;
  reference: string | null;
  notes: string | null;
  initiatedAt: Date | null;
  completedAt: Date | null;
  /** The sentence a recruiter reads, which names the source of a clearance. */
  summary: string;
  /** True only when an agency cleared it — never when somebody recorded it. */
  agencyCleared: boolean;
  /** Why an agency check cannot be started, when it cannot. */
  providerBlockedReason: string | null;
}

@Injectable()
export class BgvService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly credentials: ProviderCredentialsService,
  ) {}

  async read(orgId: string, candidateId: number): Promise<BgvView> {
    const row = await this.candidate(orgId, candidateId);
    const status = (row.bgvStatus ?? "NOT_INITIATED") as BgvStatus;
    const source = row.bgvSource ?? null;

    return {
      candidateId,
      status,
      source,
      agency: row.bgvAgency,
      reference: row.bgvReference,
      notes: row.bgvNotes,
      initiatedAt: row.bgvInitiatedAt,
      completedAt: row.bgvCompletedAt,
      summary: describeBgv(status, source),
      agencyCleared: isAgencyClearance(status, source),
      providerBlockedReason: await this.blockedReason(orgId),
    };
  }

  /**
   * Opens a case with the verification agency.
   *
   * Refuses when no agency is connected rather than moving the candidate to
   * `INITIATED`. That ordering is the point: a candidate sitting at `INITIATED`
   * with no case anywhere is worse than one still at `NOT_INITIATED`, because
   * the first looks like something is happening and nobody goes to check.
   */
  async initiate(
    orgId: string,
    /**
     * A user or a named system job. `audit_logs.user_id` has an FK to
     * `users.id`, so the offer-accept trigger cannot pass the string "system" —
     * the one row explaining why a check was opened would be the row that fails
     * to insert.
     */
    actor: { userId: string } | { systemActor: string },
    candidateId: number,
    checks: readonly BgvCheckType[],
  ): Promise<BgvView> {
    const row = await this.candidate(orgId, candidateId);
    const status = (row.bgvStatus ?? "NOT_INITIATED") as BgvStatus;
    if (status === "INITIATED" || status === "PENDING") {
      throw new ConflictException("A background check is already running for this candidate.");
    }

    const credentials = await this.credentials.forPlatform(orgId, BGV_PLATFORM);
    const resolved = resolveBgv(credentials);
    if (!("adapter" in resolved)) {
      /*
        400 rather than 503: from the caller's point of view this organisation
        has not finished setting the integration up, which is a problem with the
        request rather than a transient failure worth retrying. The message
        names the manual fallback, so the refusal is a redirection rather than a
        wall.
      */
      throw new BadRequestException(resolved.message);
    }

    const externalCaseKey = randomUUID();
    /*
      Only what the agency needs. The candidate's résumé, scorecards, salary and
      pipeline history are all one join away and none of them belong in a
      third-party's system.
    */
    const accepted = await resolved.adapter.open(resolved.credentials, {
      fullName: `${row.firstName} ${row.lastName}`,
      email: row.email,
      phone: row.phone,
      checks: [...checks],
      externalCaseKey,
    });

    const now = new Date();
    await this.db
      .update(candidates)
      .set({
        bgvStatus: "INITIATED",
        bgvSource: "AGENCY",
        bgvReference: accepted.reference,
        bgvInitiatedAt: now,
        bgvCompletedAt: null,
        updatedAt: now,
      })
      .where(and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)));

    await this.audit.logCritical({
      action: "hr.recruitment.bgv.initiated",
      orgId,
      ...actor,
      resourceType: "candidate",
      resourceId: String(candidateId),
      metadata: { reference: accepted.reference, checks, fieldsSent: ["fullName", "email", "phone"] },
    });

    return this.read(orgId, candidateId);
  }

  /**
   * Records a verdict, from a recruiter or from an agency.
   *
   * One method for both, because the transition rules are the same and the only
   * thing that differs is what the row is allowed to claim afterwards —
   * enforced by `decideVerdict` rather than by which endpoint was called.
   */
  async recordVerdict(
    orgId: string,
    actor: { userId: string } | { systemActor: string },
    candidateId: number,
    verdict: {
      status: BgvStatus;
      source: BgvSource;
      reference?: string | null;
      agency?: string | null;
      notes?: string | null;
    },
  ): Promise<BgvView> {
    const row = await this.candidate(orgId, candidateId);
    const from = (row.bgvStatus ?? "NOT_INITIATED") as BgvStatus;

    const decision = decideVerdict({
      from,
      to: verdict.status,
      source: verdict.source,
      reference: verdict.reference ?? row.bgvReference ?? null,
    });
    if (!decision.ok) throw new BadRequestException(decision.reason);

    const now = new Date();
    const fields: Partial<typeof candidates.$inferInsert> = {
      bgvStatus: verdict.status,
      bgvSource: verdict.source,
      updatedAt: now,
    };
    if (verdict.reference !== undefined && verdict.reference !== null) {
      fields.bgvReference = verdict.reference;
    }
    if (verdict.agency !== undefined) fields.bgvAgency = verdict.agency;
    if (verdict.notes !== undefined) fields.bgvNotes = verdict.notes;
    if (verdict.status === "INITIATED" && from === "NOT_INITIATED") fields.bgvInitiatedAt = now;
    if (verdict.status === "CLEARED" || verdict.status === "FAILED") fields.bgvCompletedAt = now;
    if (verdict.status === "NOT_INITIATED") {
      fields.bgvInitiatedAt = null;
      fields.bgvCompletedAt = null;
      fields.bgvReference = null;
    }

    await this.db
      .update(candidates)
      .set(fields)
      .where(and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)));

    await this.audit.logCritical({
      action: "hr.recruitment.bgv.verdict",
      orgId,
      ...actor,
      resourceType: "candidate",
      resourceId: String(candidateId),
      metadata: {
        from,
        to: verdict.status,
        source: verdict.source,
        reference: verdict.reference ?? row.bgvReference ?? null,
      },
    });

    return this.read(orgId, candidateId);
  }

  /** Finds the candidate an agency callback is about, by its case reference. */
  async byReference(orgId: string, reference: string): Promise<number | null> {
    const row = await this.db.query.candidates.findFirst({
      where: and(eq(candidates.orgId, orgId), eq(candidates.bgvReference, reference)),
      columns: { id: true },
    });
    return row?.id ?? null;
  }

  private async candidate(orgId: string, candidateId: number) {
    const row = await this.db.query.candidates.findFirst({
      where: and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)),
      columns: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        bgvStatus: true,
        bgvSource: true,
        bgvAgency: true,
        bgvReference: true,
        bgvNotes: true,
        bgvInitiatedAt: true,
        bgvCompletedAt: true,
      },
    });
    if (!row) throw new NotFoundException("Candidate not found.");
    return row;
  }

  private async blockedReason(orgId: string): Promise<string | null> {
    const credentials = await this.credentials.forPlatform(orgId, BGV_PLATFORM);
    const resolved = resolveBgv(credentials);
    return "adapter" in resolved ? null : resolved.message;
  }
}
