import { and, eq, isNull } from "drizzle-orm";
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

export function resolvePerson(
  db: Db,
  orgId: string,
  subject: PersonSubject,
): Promise<PersonResolution> {
  if (subject.kind === "user") return resolveUser(db, orgId, subject);
  if (subject.kind === "worker") return resolveWorker(db, orgId, subject);
  return resolvePersonRecord(db, orgId, subject);
}
