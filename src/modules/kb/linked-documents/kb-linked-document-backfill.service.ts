import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { documentAudiences, documents } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { publishBlockers, type PublishBlocker } from "../../hr/performance/documents-helpers";
import { withMetadataPiiBlocker } from "../../hr/performance/document-pii-scan";
import { KbHrLinkFlagsService } from "../core/kb-hr-link-flags.service";
import type { PublishActor } from "./kb-linked-document-publish.service";
import type { BackfillInput, BackfillResult } from "./dto/kb-link-backfill.schemas";

const SAMPLE_SIZE = 20;

type Skipped = BackfillResult["skipped"];
const SKIP_BUCKET: Record<PublishBlocker["code"], keyof Skipped | null> = {
  CLASSIFICATION_NOT_SHAREABLE: null,
  DOCUMENT_INACTIVE: "inactive",
  TYPE_NOT_ALLOWED: "typeNotAllowed",
  BELONGS_TO_AN_EMPLOYEE: "belongsToAnEmployee",
  HIRING_ARTEFACT: "hiringArtefact",
  METADATA_HOLDS_PERSONAL_IDENTIFIER: "holdsPersonalIdentifier",
};

@Injectable()
export class KbLinkedDocumentBackfillService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly flags: KbHrLinkFlagsService,
  ) {}

  async run(actor: PublishActor, input: BackfillInput): Promise<BackfillResult> {
    const { orgId } = actor;
    await this.flags.assertEnabled(orgId, "link");

    return runInTenantTransaction(
      this.db,
      async (tx) => {
        const page = await tx
          .select({
            id: documents.id,
            orgId: documents.orgId,
            fileUrl: documents.fileUrl,
            name: documents.name,
            type: documents.type,
            userId: documents.userId,
            uploadedBy: documents.uploadedBy,
            classification: documents.classification,
            isActive: documents.isActive,
            isPublic: documents.isPublic,
            metadata: documents.metadata,
            description: documents.description,
            category: documents.category,
            tags: documents.tags,
            hasAudience: sql<boolean>`EXISTS (SELECT 1 FROM document_audiences da WHERE da.org_id = "documents"."org_id" AND da.document_id = "documents"."id")`,
            wasClassifiedByAPerson: sql<boolean>`EXISTS (SELECT 1 FROM audit_logs al WHERE al.org_id = "documents"."org_id" AND al.target_id = "documents"."id"::text AND al.target_type = 'document' AND al.action = 'hr.document.classified')`,
          })
          .from(documents)
          .where(and(eq(documents.orgId, orgId), gt(documents.id, input.cursor)))
          .orderBy(asc(documents.id))
          .limit(input.limit);

        const skipped: Skipped = { alreadyClassified: 0, belongsToAnEmployee: 0, typeNotAllowed: 0, hiringArtefact: 0, inactive: 0, holdsPersonalIdentifier: 0 };
        const proposals: Array<{ id: number; name: string; audience: "ALL_EMPLOYEES" | "HR_ONLY" }> = [];
        for (const row of page) {
          if (row.classification !== "PERSONAL" || row.hasAudience || row.wasClassifiedByAPerson) {
            skipped.alreadyClassified += 1;
            continue;
          }
          const blocker = withMetadataPiiBlocker(publishBlockers({ ...row, classification: "INTERNAL" }), row).find(
            (candidate) => SKIP_BUCKET[candidate.code] !== null,
          );
          const bucket = blocker ? SKIP_BUCKET[blocker.code] : null;
          if (bucket) {
            skipped[bucket] += 1;
            continue;
          }
          proposals.push({ id: row.id, name: row.name, audience: row.isPublic ? "ALL_EMPLOYEES" : "HR_ONLY" });
        }

        let applied = 0;
        const appliedIds: number[] = [];
        if (!input.dryRun && proposals.length > 0) {
          const changed = await tx
            .update(documents)
            .set({ classification: "INTERNAL", updatedAt: new Date() })
            .where(and(eq(documents.orgId, orgId), inArray(documents.id, proposals.map((proposal) => proposal.id)), eq(documents.classification, "PERSONAL")))
            .returning({ id: documents.id });
          const changedIds = new Set(changed.map((row) => row.id));
          const forEveryone = proposals.filter((proposal) => proposal.audience === "ALL_EMPLOYEES" && changedIds.has(proposal.id));
          if (forEveryone.length > 0)
            await tx
              .insert(documentAudiences)
              .values(forEveryone.map((proposal) => ({ orgId, documentId: proposal.id, kind: "ALL_EMPLOYEES" as const, refId: null, createdByMembershipId: actor.membershipId })))
              .onConflictDoNothing();
          applied = changedIds.size;
          appliedIds.push(...changedIds);
        }

        const last = page.at(-1);
        const done = page.length < input.limit;
        const result: BackfillResult = {
          dryRun: input.dryRun,
          scanned: page.length,
          eligible: proposals.length,
          proposals: {
            allEmployees: proposals.filter((proposal) => proposal.audience === "ALL_EMPLOYEES").length,
            hrOnly: proposals.filter((proposal) => proposal.audience === "HR_ONLY").length,
          },
          skipped,
          applied,
          nextCursor: done || !last ? null : last.id,
          done,
          sample: proposals.slice(0, SAMPLE_SIZE).map((proposal) => ({ documentId: proposal.id, name: proposal.name, audience: proposal.audience })),
        };
        await this.audit.logCritical({
          action: "kb.hr_link.backfill_run",
          userId: actor.userId,
          orgId,
          targetId: orgId,
          targetType: "documents",
          metadata: {
            dryRun: input.dryRun,
            cursor: input.cursor,
            nextCursor: result.nextCursor,
            scanned: result.scanned,
            eligible: result.eligible,
            proposals: result.proposals,
            skipped,
            applied,
            documentIds: appliedIds,
          },
        });
        return result;
      },
      { orgId },
    );
  }
}
