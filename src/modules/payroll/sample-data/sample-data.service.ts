import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { AuditService } from "../../../common/audit/audit.service";
import { isForeignKeyViolation } from "../../../common/db/postgres-error";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { employeeSalaryProfiles, organizationPeople, workerEngagements, workers } from "../../../db/schema";
import { DirectoryService } from "../../directory/directory.service";
import { ProfilesService } from "../runs/profiles.service";
import type { SampleDataStatus } from "./dto/sample-data.schemas";

export const SAMPLE_EMAIL_DOMAIN = "payroll-sample.example.test";
export const SAMPLE_TAG = "streamline:sample";

export const SAMPLE_PEOPLE: ReadonlyArray<{ first: string; last: string; annualCtc: string | null }> = [
  { first: "Asha", last: "Rao", annualCtc: "1200000" },
  { first: "Vikram", last: "Iyer", annualCtc: "900000" },
  { first: "Meera", last: "Nair", annualCtc: "1500000" },
  { first: "Rohan", last: "Das", annualCtc: null },
  { first: "Kavya", last: "Menon", annualCtc: null },
];

export type SampleActor = { userId: string; membershipId: number | null };

const qb = new QueryBuilder();

function firstOfMonth(now: Date): string {
  return `${now.toISOString().slice(0, 7)}-01`;
}

@Injectable()
export class PayrollSampleDataService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly directory: DirectoryService,
    private readonly profiles: ProfilesService,
    private readonly audit: AuditService,
  ) {}

  private samplePersonFilter(orgId: string) {
    return and(
      eq(organizationPeople.organizationId, orgId),
      sql`lower(${organizationPeople.workEmail}) like ${`%@${SAMPLE_EMAIL_DOMAIN}`}`,
    );
  }

  private samplePeople(orgId: string) {
    return qb
      .select({ id: organizationPeople.organizationPersonId })
      .from(organizationPeople)
      .where(this.samplePersonFilter(orgId));
  }

  private sampleWorkers(orgId: string) {
    return qb
      .select({ id: workers.workerId })
      .from(workers)
      .where(and(eq(workers.organizationId, orgId), inArray(workers.organizationPersonId, this.samplePeople(orgId))));
  }

  async status(orgId: string): Promise<SampleDataStatus> {
    const [row] = await this.db
      .select({
        people: sql<number>`count(*)::int`,
        payees: sql<number>`(select count(*) from ${workers} where ${workers.organizationId} = ${orgId} and ${workers.isPayee} and ${workers.workerId} in (${this.sampleWorkers(orgId)}))::int`,
        salaryProfiles: sql<number>`(select count(*) from ${employeeSalaryProfiles} where ${employeeSalaryProfiles.orgId} = ${orgId} and ${employeeSalaryProfiles.costCenter} = ${SAMPLE_TAG} and ${employeeSalaryProfiles.workerId} in (${this.sampleWorkers(orgId)}))::int`,
      })
      .from(organizationPeople)
      .where(this.samplePersonFilter(orgId));
    const people = Number(row?.people ?? 0);
    return {
      present: people > 0,
      people,
      payees: Number(row?.payees ?? 0),
      salaryProfiles: Number(row?.salaryProfiles ?? 0),
    };
  }

  async seed(orgId: string, actor: SampleActor, now: Date = new Date()): Promise<SampleDataStatus> {
    await this.db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`payroll-sample:${orgId}`}, 0))`);
    const current = await this.status(orgId);
    if (current.present) return current;

    const startsOn = firstOfMonth(now);
    for (const sample of SAMPLE_PEOPLE) {
      const person = await this.directory.createPerson(orgId, actor.userId, {
        firstName: `Sample · ${sample.first}`,
        lastName: sample.last,
        workEmail: `${sample.first}.${sample.last}@${SAMPLE_EMAIL_DOMAIN}`.toLowerCase(),
      });
      const worker = await this.directory.createWorker(orgId, actor.userId, {
        organizationPersonId: person.organizationPersonId,
        isPayee: true,
      });
      await this.directory.createEngagement(orgId, actor.userId, actor.membershipId, {
        workerId: worker.workerId,
        startsOn,
        workerType: "FULL_TIME",
        isPrimary: true,
        designation: "Sample employee",
      });
      if (sample.annualCtc) {
        await this.profiles.createProfileByWorker(orgId, worker.workerId, actor.userId, {
          effectiveFrom: startsOn,
          annualCtc: sample.annualCtc,
          workerType: "EMPLOYEE",
          currency: "INR",
          costCenter: SAMPLE_TAG,
          components: [],
        });
      }
    }

    const seeded = await this.status(orgId);
    await this.audit.logCritical({
      action: "payroll.sample_data.seeded",
      userId: actor.userId,
      orgId,
      resourceType: "payroll_sample_data",
      resourceId: orgId,
      metadata: { ...seeded },
    });
    return seeded;
  }

  async remove(orgId: string, actor: SampleActor): Promise<SampleDataStatus> {
    const before = await this.status(orgId);
    if (!before.present) return before;

    try {
      await this.db
        .delete(employeeSalaryProfiles)
        .where(
          and(
            eq(employeeSalaryProfiles.orgId, orgId),
            eq(employeeSalaryProfiles.costCenter, SAMPLE_TAG),
            inArray(employeeSalaryProfiles.workerId, this.sampleWorkers(orgId)),
          ),
        );
      await this.db
        .delete(workerEngagements)
        .where(
          and(eq(workerEngagements.organizationId, orgId), inArray(workerEngagements.workerId, this.sampleWorkers(orgId))),
        );
      await this.db
        .delete(workers)
        .where(and(eq(workers.organizationId, orgId), inArray(workers.organizationPersonId, this.samplePeople(orgId))));
      await this.db.delete(organizationPeople).where(this.samplePersonFilter(orgId));
    } catch (error) {
      if (isForeignKeyViolation(error)) {
        throw new ConflictException(
          "Sample people are now used by records you created (a salary profile, payroll run, leave or attendance). Remove those first.",
        );
      }
      throw error;
    }

    await this.audit.logCritical({
      action: "payroll.sample_data.removed",
      userId: actor.userId,
      orgId,
      resourceType: "payroll_sample_data",
      resourceId: orgId,
      metadata: { ...before },
    });
    return this.status(orgId);
  }
}
