import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, gt, lte } from "drizzle-orm";
import { organizationMembers, users } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { HrAuditService } from "./hr-audit.service";
import { PersonEmploymentSyncService } from "./person-employment-sync.service";
import { toEnsureInput, type BackfillResult, type PrefetchedActiveMember } from "./person-employment-sync.types";

const BACKFILL_FETCH_SIZE = 100;
const BACKFILL_CONCURRENCY = 4;
const BACKFILL_ERROR_MESSAGE = "Member synchronization failed";

@Injectable()
export class PersonEmploymentBackfillService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: HrAuditService,
    private readonly sync: PersonEmploymentSyncService,
  ) {}

  async backfillOrg(
    orgId: string,
    actorId: string | null,
  ): Promise<BackfillResult> {
    const result: BackfillResult = {
      scanned: 0,
      createdPeople: 0,
      createdEmployments: 0,
      skipped: 0,
      errors: [],
    };
    const highWatermark = await this.getBackfillHighWatermark(orgId);

    if (highWatermark !== null) {
      let afterMembershipId = 0;
      while (afterMembershipId < highWatermark) {
        const members = await this.loadActiveMemberBatch(
          orgId,
          afterMembershipId,
          highWatermark,
        );
        if (members.length === 0) break;

        result.scanned += members.length;
        await this.processMemberBatch(orgId, actorId, members, result);

        const lastMember = members.at(-1);
        if (!lastMember) break;
        afterMembershipId = lastMember.membershipId;
        if (members.length < BACKFILL_FETCH_SIZE) break;
      }
    }

    await runInNewTenantTransaction(this.db, orgId, () =>
      this.audit.log({
        orgId,
        actorId,
        entityType: "hr_people",
        entityId: orgId,
        action: "backfill_from_members",
        after: {
          scanned: result.scanned,
          createdPeople: result.createdPeople,
          createdEmployments: result.createdEmployments,
          skipped: result.skipped,
          errorCount: result.errors.length,
        },
      }),
    );

    return result;
  }

  private async getBackfillHighWatermark(orgId: string): Promise<number | null> {
    return runInNewTenantTransaction(this.db, orgId, async (tx) => {
      const [row] = await tx
        .select({ membershipId: organizationMembers.id })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            eq(organizationMembers.status, "ACTIVE"),
          ),
        )
        .orderBy(desc(organizationMembers.id))
        .limit(1);
      return row?.membershipId ?? null;
    });
  }

  private loadActiveMemberBatch(
    orgId: string,
    afterMembershipId: number,
    highWatermark: number,
  ): Promise<PrefetchedActiveMember[]> {
    return runInNewTenantTransaction(this.db, orgId, (tx) =>
      tx
        .select({
          membershipId: organizationMembers.id,
          userId: users.id,
          firstName: users.firstName,
          lastName: users.lastName,
          name: users.name,
          email: users.email,
          phone: users.phone,
        })
        .from(organizationMembers)
        .innerJoin(users, eq(users.id, organizationMembers.userId))
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            eq(organizationMembers.status, "ACTIVE"),
            gt(organizationMembers.id, afterMembershipId),
            lte(organizationMembers.id, highWatermark),
          ),
        )
        .orderBy(asc(organizationMembers.id))
        .limit(BACKFILL_FETCH_SIZE),
    );
  }

  private async processMemberBatch(
    orgId: string,
    actorId: string | null,
    members: PrefetchedActiveMember[],
    result: BackfillResult,
  ): Promise<void> {
    for (let start = 0; start < members.length; start += BACKFILL_CONCURRENCY) {
      const window = members.slice(start, start + BACKFILL_CONCURRENCY);
      const settled = await Promise.allSettled(
        window.map((member) =>
          runInNewTenantTransaction(this.db, orgId, () =>
            this.sync.ensureFromUser(orgId, actorId, toEnsureInput(member, "ACTIVE")),
          ),
        ),
      );

      for (let index = 0; index < settled.length; index += 1) {
        const outcome = settled[index];
        const member = window[index];
        if (!outcome || !member) continue;
        if (outcome.status === "rejected") {
          result.errors.push({
            userId: member.userId,
            message: BACKFILL_ERROR_MESSAGE,
          });
          continue;
        }
        if (outcome.value.createdPerson) result.createdPeople += 1;
        if (outcome.value.createdEmployment) result.createdEmployments += 1;
        if (!outcome.value.createdPerson && !outcome.value.createdEmployment)
          result.skipped += 1;
      }
    }
  }
}
