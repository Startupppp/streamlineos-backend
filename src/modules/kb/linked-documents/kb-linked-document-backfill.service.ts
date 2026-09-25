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
  // What the backfill is here to change, so it is never a reason to skip.
  CLASSIFICATION_NOT_SHAREABLE: null,
  DOCUMENT_INACTIVE: "inactive",
  TYPE_NOT_ALLOWED: "typeNotAllowed",
  BELONGS_TO_AN_EMPLOYEE: "belongsToAnEmployee",
  HIRING_ARTEFACT: "hiringArtefact",
  // Proposing Internal for a document whose searchable details hold an identifier would only be refused by
  // classify(), so the backfill skips it and says so rather than counting it eligible (V-156).
  METADATA_HOLDS_PERSONAL_IDENTIFIER: "holdsPersonalIdentifier",
};

/**
 * Proposes a classification for the HR documents that already look like company documents, and can apply it.
 * Every document starts as Personal, so without this HR would classify each existing policy by hand. What it
 * proposes preserves what people can see TODAY: a company-level document that is public to employees becomes
 * Internal for all employees; one that is not becomes Internal for HR only. It never publishes anything (there
 * is no link, so nothing shows in the knowledge base until a person adds it), never touches a document HR has
 * already classified or given an audience, and never proposes anything for a document that belongs to a person.
 *
 * One page per call, by document id. A dry run (the default) changes nothing and says what would change. A run
 * that applies is safe to repeat or resume: what it changed is no longer eligible, so the next pass skips it.
 * Every run, dry or not, is audited once with the counts and the ids it changed.
 */
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
            // For the metadata PII scan (V-156); `name` is already read above for the sample.
            description: documents.description,
            category: documents.category,
            tags: documents.tags,
            // Written out: in a single-table select drizzle renders columns unqualified, so `${documents.orgId}` inside the subquery would resolve to the INNER table and the test would always be false.
            hasAudience: sql<boolean>`EXISTS (SELECT 1 FROM document_audiences da WHERE da.org_id = "documents"."org_id" AND da.document_id = "documents"."id")`,
            // A person once classified it, even if the answer was "Personal" (that also clears the audience, so the two tests above cannot see it). Written out for the same reason as above.
            wasClassifiedByAPerson: sql<boolean>`EXISTS (SELECT 1 FROM audit_logs al WHERE al.org_id = "documents"."org_id" AND al.target_id = "documents"."id"::text AND al.target_type = 'document' AND al.action = 'hr.document.classified')`,
          })
          .from(documents)
          .where(and(eq(documents.orgId, orgId), gt(documents.id, input.cursor)))
          .orderBy(asc(documents.id))
          .limit(input.limit);

        const skipped: Skipped = { alreadyClassified: 0, belongsToAnEmployee: 0, typeNotAllowed: 0, hiringArtefact: 0, inactive: 0, holdsPersonalIdentifier: 0 };
        const proposals: Array<{ id: number; name: string; audience: "ALL_EMPLOYEES" | "HR_ONLY" }> = [];
        for (const row of page) {
          // HR's own choice, however partial, is never overwritten.
          if (row.classification !== "PERSONAL" || row.hasAudience || row.wasClassifiedByAPerson) {
            skipped.alreadyClassified += 1;
            continue;
          }
          // Judged as if it were Internal: the classification is the one thing this run is about to change.
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
          // The predicate repeats `classification = 'PERSONAL'`, so a document someone classified since the page was read is left alone.
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
