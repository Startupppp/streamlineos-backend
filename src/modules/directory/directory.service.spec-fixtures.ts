import { Test } from "@nestjs/testing";
import { AuditService } from "../../common/audit/audit.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { DirectoryIdentityService } from "./directory-identity.service";
import { DirectoryService } from "./directory.service";
import { WorkerEngagementsService } from "./worker-engagements.service";

export const ORG_ID = "org-aaaaaaaa-0000-0000-0000-000000000001";
export const OTHER_ORG = "org-aaaaaaaa-0000-0000-0000-000000000099";
export const USER_ID = "user-aaaa-0000-0000-0000-000000000001";
export const PERSON_ID = "person-aa-0000-0000-0000-000000000001";
export const WORKER_ID = "worker-aa-0000-0000-0000-000000000001";
export const ENGAGEMENT_ID = "engage-aa-0000-0000-0000-000000000001";

export const mockAudit = { logCritical: jest.fn() } as unknown as AuditService;
export const mockIdentities = {
  reconcilePersonIdentity: jest.fn(),
  resolveLinkForPersonWrite: jest.fn(),
  ensurePersonForMember: jest.fn(),
  resolvePersonAccess: jest.fn(),
  resolvePeopleAccess: jest.fn(),
};

export function makePerson(overrides: Record<string, unknown> = {}) {
  return {
    organizationPersonId: PERSON_ID,
    organizationId: ORG_ID,
    firstName: "Jane",
    lastName: "Doe",
    displayName: null,
    preferredName: null,
    workEmail: "jane@example.com",
    personalEmail: null,
    phone: null,
    whatsappNumber: null,
    avatarUrl: null,
    dateOfBirth: null,
    gender: null,
    nationality: null,
    timezone: null,
    languageCode: null,
    linkedinUrl: null,
    githubUrl: null,
    bio: null,
    userId: null,
    organizationMembershipId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}
export function makeWorker(overrides: Record<string, unknown> = {}) {
  return {
    workerId: WORKER_ID,
    organizationId: ORG_ID,
    organizationPersonId: PERSON_ID,
    workerNumber: "W-001",
    status: "ACTIVE",
    isPayee: false,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

export function makeEngagement(overrides: Record<string, unknown> = {}) {
  return {
    workerEngagementId: ENGAGEMENT_ID,
    organizationId: ORG_ID,
    workerId: WORKER_ID,
    startsOn: "2024-01-01",
    endsOn: null,
    workerType: "FULL_TIME",
    status: "ACTIVE",
    isPrimary: true,
    designation: "Engineer",
    departmentId: null,
    businessUnitId: null,
    branchId: null,
    locationId: null,
    teamId: null,
    managerEngagementId: null,
    jobRoleId: null,
    jobLevelId: null,
    employmentTypeId: null,
    probationEndsOn: null,
    noticePeriodDays: null,
    terminationReason: null,
    terminationNotes: null,
    rowVersion: 1,
    createdBy: USER_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

export function makeSelectChain(rows: unknown[]) {
  const limitFn = jest.fn().mockResolvedValue(rows);
  const whereChain = { limit: limitFn };
  const fromChain = { where: jest.fn().mockReturnValue(whereChain) };
  const selectChain = { from: jest.fn().mockReturnValue(fromChain) };
  return { selectChain, fromChain, whereChain };
}

export async function createDirectoryTestHarness(): Promise<{
  service: DirectoryService;
  database: Record<string, unknown>;
}> {
  jest.resetAllMocks();
  mockIdentities.reconcilePersonIdentity.mockImplementation(
    async (_organizationId: string, person: unknown) => person,
  );
  mockIdentities.resolvePersonAccess.mockImplementation(
    async (_organizationId: string, person: unknown) => person,
  );
  mockIdentities.resolvePeopleAccess.mockImplementation(
    async (_organizationId: string, people: unknown[]) => people,
  );
  mockIdentities.resolveLinkForPersonWrite.mockResolvedValue(null);

  const database: Record<string, unknown> = {
    select: jest.fn(),
    insert: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    query: {},
  };

  const testingModule = await Test.createTestingModule({
    providers: [
      DirectoryService,
      WorkerEngagementsService,
      { provide: DRIZZLE, useValue: database },
      { provide: AuditService, useValue: mockAudit },
      { provide: DirectoryIdentityService, useValue: mockIdentities },
    ],
  }).compile();

  return {
    service: testingModule.get(DirectoryService),
    database,
  };
}
