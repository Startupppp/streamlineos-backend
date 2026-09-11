import { and, eq, inArray, isNull, or, type SQL } from "drizzle-orm";
import {
  hrEmployments,
  hrPeople,
  organizationMembers,
  organizationPeople,
  workers,
} from "../../db/schema";
import type { Db } from "../../db/drizzle.module";

export type PersonSubject =
  | { kind: "user"; userId: string }
  | { kind: "worker"; workerId: string }
  | { kind: "person"; organizationPersonId: string };

export type PersonEmployment = {
  employmentId: number;
  employeeNumber: string;
  lifecycleStatus: string;
};

export type PersonResolutionPath = "membership" | "payee-worker" | "person-record";

export type PayableIdentity =
  | { kind: "user"; userId: string }
  | { kind: "worker"; workerId: string };

export type ResolvedPerson = {
  resolvedVia: PersonResolutionPath;
  organizationPersonId: string | null;
  userId: string | null;
  workerId: string | null;
  isMember: boolean;
  isPayeeWorker: boolean;
  employment: PersonEmployment | null;
  payableAs: PayableIdentity | null;
  payable: boolean;
};

export type PersonResolution =
  | { status: "resolved"; person: ResolvedPerson }
  | { status: "unresolved"; subject: PersonSubject };

function unresolved(subject: PersonSubject): PersonResolution {
  return { status: "unresolved", subject };
}

function resolved(
  person: Omit<ResolvedPerson, "payable">,
): PersonResolution {
  return {
    status: "resolved",
    person: { ...person, payable: person.payableAs !== null },
  };
}

function payeeWorkerColumns() {
  return {
    workerId: workers.workerId,
    organizationPersonId: organizationPeople.organizationPersonId,
    userId: organizationPeople.userId,
  };
}

function payeeWorkerJoin() {
  return and(
    eq(workers.organizationPersonId, organizationPeople.organizationPersonId),
    eq(workers.organizationId, organizationPeople.organizationId),
  );
}

async function findPayeeWorkerByUser(db: Db, orgId: string, userId: string) {
  const [row] = await db
    .select(payeeWorkerColumns())
    .from(workers)
    .innerJoin(organizationPeople, payeeWorkerJoin())
    .where(
      and(
        eq(workers.organizationId, orgId),
        eq(organizationPeople.userId, userId),
        eq(workers.isPayee, true),
        isNull(workers.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function findPayeeWorkerById(db: Db, orgId: string, workerId: string) {
  const [row] = await db
    .select(payeeWorkerColumns())
    .from(workers)
    .innerJoin(organizationPeople, payeeWorkerJoin())
    .where(
      and(
        eq(workers.organizationId, orgId),
        eq(workers.workerId, workerId),
        eq(workers.isPayee, true),
        isNull(workers.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function findEmployment(
  db: Db,
  orgId: string,
  organizationPersonId: string,
): Promise<PersonEmployment | null> {
  const [row] = await db
    .select({
      employmentId: hrEmployments.id,
      employeeNumber: hrEmployments.employeeNumber,
      lifecycleStatus: hrEmployments.lifecycleStatus,
    })
    .from(hrEmployments)
    .innerJoin(hrPeople, eq(hrEmployments.personId, hrPeople.id))
    .where(
      and(
        eq(hrEmployments.orgId, orgId),
        eq(hrPeople.orgId, orgId),
        eq(hrPeople.organizationPersonId, organizationPersonId),
        isNull(hrPeople.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function resolveUser(
  db: Db,
  orgId: string,
  subject: Extract<PersonSubject, { kind: "user" }>,
): Promise<PersonResolution> {
  const membership = await db.query.organizationMembers.findFirst({
    where: and(
      eq(organizationMembers.orgId, orgId),
      eq(organizationMembers.userId, subject.userId),
    ),
    columns: { id: true },
  });
  if (membership) {
    return resolved({
      resolvedVia: "membership",
      organizationPersonId: null,
      userId: subject.userId,
      workerId: null,
      isMember: true,
      isPayeeWorker: false,
      employment: null,
      payableAs: { kind: "user", userId: subject.userId },
    });
  }

  const worker = await findPayeeWorkerByUser(db, orgId, subject.userId);
  if (!worker) return unresolved(subject);

  return resolved({
    resolvedVia: "payee-worker",
    organizationPersonId: worker.organizationPersonId ?? null,
    userId: worker.userId ?? subject.userId,
    workerId: worker.workerId,
    isMember: false,
    isPayeeWorker: true,
    employment: null,
    payableAs: { kind: "worker", workerId: worker.workerId },
  });
}

async function resolveWorker(
  db: Db,
  orgId: string,
  subject: Extract<PersonSubject, { kind: "worker" }>,
): Promise<PersonResolution> {
  const worker = await findPayeeWorkerById(db, orgId, subject.workerId);
  if (!worker) return unresolved(subject);

  return resolved({
    resolvedVia: "payee-worker",
    organizationPersonId: worker.organizationPersonId ?? null,
    userId: worker.userId ?? null,
    workerId: worker.workerId,
    isMember: false,
    isPayeeWorker: true,
    employment: null,
    payableAs: { kind: "worker", workerId: worker.workerId },
  });
}

function payableIdentityForPerson(
  isMember: boolean,
  userId: string | null,
  isPayeeWorker: boolean,
  workerId: string | null,
): PayableIdentity | null {
  if (isMember && userId) return { kind: "user", userId };
  if (isPayeeWorker && workerId) return { kind: "worker", workerId };
  return null;
}

async function resolvePersonRecord(
  db: Db,
  orgId: string,
  subject: Extract<PersonSubject, { kind: "person" }>,
): Promise<PersonResolution> {
  const [person] = await db
    .select({
      organizationPersonId: organizationPeople.organizationPersonId,
      userId: organizationPeople.userId,
      membershipId: organizationPeople.organizationMembershipId,
    })
    .from(organizationPeople)
    .where(
      and(
        eq(organizationPeople.organizationId, orgId),
        eq(
          organizationPeople.organizationPersonId,
          subject.organizationPersonId,
        ),
        isNull(organizationPeople.deletedAt),
      ),
    )
    .limit(1);
  if (!person) return unresolved(subject);

  const [worker] = await db
    .select({ workerId: workers.workerId, isPayee: workers.isPayee })
    .from(workers)
    .where(
      and(
        eq(workers.organizationId, orgId),
        eq(workers.organizationPersonId, person.organizationPersonId),
        isNull(workers.deletedAt),
      ),
    )
    .limit(1);

  const employment = await findEmployment(
    db,
    orgId,
    person.organizationPersonId,
  );
  const isMember = person.membershipId !== null;
  const isPayeeWorker = worker?.isPayee === true;

  return resolved({
    resolvedVia: "person-record",
    organizationPersonId: person.organizationPersonId,
    userId: person.userId,
    workerId: worker?.workerId ?? null,
    isMember,
    isPayeeWorker,
    employment,
    payableAs: payableIdentityForPerson(
      isMember,
      person.userId,
      isPayeeWorker,
      worker?.workerId ?? null,
    ),
  });
}

/**
 * Whether this organisation holds this worker at all — existence, not payroll standing.
 *
 * `resolvePerson({ kind: "worker" })` answers a NARROWER question: `findPayeeWorkerById` filters on
 * `is_payee = true`, so a worker the organisation employs but does not pay resolves `unresolved`.
 * That is the right bar for "may this person be paid" and the wrong one for "does the caller's
 * organisation hold the object named in this url" — a route that borrowed the second from the first
 * would 404 its own tenant's non-payee worker, which is a behaviour change and not a tenant guard.
 * Callers that need the payroll bar keep `assertPayrollWorkerPayeeEligible`.
 */
export async function workerBelongsToOrg(db: Db, orgId: string, workerId: string): Promise<boolean> {
  const [row] = await db
    .select({ workerId: workers.workerId })
    .from(workers)
    .where(
      and(
        eq(workers.organizationId, orgId),
        eq(workers.workerId, workerId),
        isNull(workers.deletedAt),
      ),
    )
    .limit(1);
  return row !== undefined;
}

export function resolvePerson(
  db: Db,
  orgId: string,
  subject: PersonSubject,
): Promise<PersonResolution> {
  if (subject.kind === "user") return resolveUser(db, orgId, subject);
  if (subject.kind === "worker") return resolveWorker(db, orgId, subject);
  return resolvePersonRecord(db, orgId, subject);
}

export type PersonIdentity = {
  organizationPersonId: string;
  userId: string | null;
  workerId: string | null;
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
  workEmail: string | null;
  avatarUrl: string | null;
  isMember: boolean;
  isPayeeWorker: boolean;
};

export function subjectKey(subject: PersonSubject): string {
  if (subject.kind === "user") return `user:${subject.userId}`;
  if (subject.kind === "worker") return `worker:${subject.workerId}`;
  return `person:${subject.organizationPersonId}`;
}

// One query for many subjects; anchored on organization_people, so an absent subject means identity unknown, never "skip".
export async function resolvePeopleIdentities(
  db: Db,
  orgId: string,
  subjects: PersonSubject[],
): Promise<Map<string, PersonIdentity>> {
  const identities = new Map<string, PersonIdentity>();
  if (subjects.length === 0) return identities;

  const userIds = subjects.filter((s) => s.kind === "user").map((s) => s.userId);
  const workerIds = subjects
    .filter((s) => s.kind === "worker")
    .map((s) => s.workerId);
  const personIds = subjects
    .filter((s) => s.kind === "person")
    .map((s) => s.organizationPersonId);

  const matchers: SQL[] = [];
  if (userIds.length > 0)
    matchers.push(inArray(organizationPeople.userId, userIds));
  if (workerIds.length > 0) matchers.push(inArray(workers.workerId, workerIds));
  if (personIds.length > 0)
    matchers.push(inArray(organizationPeople.organizationPersonId, personIds));
  const anySubject = or(...matchers);
  if (!anySubject) return identities;

  const rows = await db
    .select({
      organizationPersonId: organizationPeople.organizationPersonId,
      userId: organizationPeople.userId,
      displayName: organizationPeople.displayName,
      firstName: organizationPeople.firstName,
      lastName: organizationPeople.lastName,
      workEmail: organizationPeople.workEmail,
      avatarUrl: organizationPeople.avatarUrl,
      workerId: workers.workerId,
      isPayee: workers.isPayee,
      membershipId: organizationMembers.id,
    })
    .from(organizationPeople)
    .leftJoin(
      workers,
      and(
        eq(workers.organizationPersonId, organizationPeople.organizationPersonId),
        eq(workers.organizationId, organizationPeople.organizationId),
        isNull(workers.deletedAt),
      ),
    )
    .leftJoin(
      organizationMembers,
      and(
        eq(organizationMembers.userId, organizationPeople.userId),
        eq(organizationMembers.orgId, organizationPeople.organizationId),
      ),
    )
    .where(
      and(
        eq(organizationPeople.organizationId, orgId),
        isNull(organizationPeople.deletedAt),
        anySubject,
      ),
    );

  for (const row of rows) {
    const identity: PersonIdentity = {
      organizationPersonId: row.organizationPersonId,
      userId: row.userId ?? null,
      workerId: row.workerId ?? null,
      displayName: row.displayName ?? null,
      firstName: row.firstName ?? null,
      lastName: row.lastName ?? null,
      workEmail: row.workEmail ?? null,
      avatarUrl: row.avatarUrl ?? null,
      isMember: row.membershipId !== null && row.membershipId !== undefined,
      isPayeeWorker: row.isPayee === true,
    };
    identities.set(
      subjectKey({
        kind: "person",
        organizationPersonId: identity.organizationPersonId,
      }),
      identity,
    );
    if (identity.userId)
      identities.set(subjectKey({ kind: "user", userId: identity.userId }), identity);
    if (identity.workerId)
      identities.set(
        subjectKey({ kind: "worker", workerId: identity.workerId }),
        identity,
      );
  }

  const requested = new Set(subjects.map(subjectKey));
  for (const key of [...identities.keys()])
    if (!requested.has(key)) identities.delete(key);

  return identities;
}
