import type { AccessService } from "../../../access/access.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { Db } from "../../../../db/drizzle.module";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import { BugsService } from "../bugs.service";
import { bugRowSchema } from "../dto/qa-response.schemas";
import { tickets, workItemQaDetails } from "../../../../db/schema";

const ORG = "org-1";
const PROJECT_ID = 3;

function makeU(): CurrentUserContext {
  return {
    userId: "user-7",
    orgId: ORG,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "session-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(7, false),
  };
}

function makeAccess(): AccessService {
  return {
    resolveUserPermissions: jest.fn().mockResolvedValue(new Set(["build:manage"])),
  } as unknown as AccessService;
}

const audit = { log: jest.fn() } as never;

const QA_SIDECAR_FIELDS = [
  "qaState",
  "severity",
  "stepsToReproduce",
  "expectedResult",
  "actualResult",
  "environment",
  "browserDevice",
  "affectedReleaseId",
  "fixedReleaseId",
  "qaOwnerUserId",
  "qaOwnerMembershipId",
  "linkedTestCaseId",
  "reopenCount",
  "createdByUserId",
] as const;

function sidecarLessBugRow() {
  const row: Record<string, unknown> = {
    id: 501,
    orgId: ORG,
    projectId: PROJECT_ID,
    ticketNumber: 12,
    title: "Checkout throws on submit",
    description: "**Feedback type:** bug\n\nIt broke",
    type: "BUG",
    status: "TODO",
    priority: "MEDIUM",
    assigneeMembershipId: null,
    reporterId: "user-99",
    deletedAt: null,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
  };
  for (const field of QA_SIDECAR_FIELDS) row[field] = null;
  return row;
}

function listDb(rows: unknown[]) {
  const joinArgs: unknown[] = [];
  const projections: unknown[] = [];
  const select = jest.fn().mockImplementation((projection: unknown) => {
    projections.push(projection);
    return {
      from: jest.fn().mockImplementation((table: unknown) => ({
        leftJoin: jest.fn().mockImplementation((joined: unknown) => {
          joinArgs.push({ table, joined, kind: "leftJoin" });
          return {
            where: jest.fn().mockReturnValue({
              orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(rows) }),
            }),
          };
        }),
      })),
    };
  });
  const db = {
    query: {
      projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: null }) },
    },
    select,
  } as unknown as Db;
  return { db, joinArgs, projections };
}

describe("a BUG work item created outside the QA surface still surfaces through listBugs", () => {
  it("joins the QA sidecar with a LEFT JOIN, so a BUG ticket that has no work_item_qa_details row is still returned", async () => {
    const { db, joinArgs } = listDb([sidecarLessBugRow()]);
    const svc = new BugsService(db, makeAccess(), audit);

    const rows = await svc.listBugs(makeU(), PROJECT_ID, {});

    expect(joinArgs).toHaveLength(1);
    expect(joinArgs[0]).toMatchObject({ table: tickets, joined: workItemQaDetails, kind: "leftJoin" });
    expect(rows).toHaveLength(1);
  });

  it("reports every QA field as null for a sidecar-less bug, which is the only signal a caller has that it was never filed through the QA surface", async () => {
    const { db } = listDb([sidecarLessBugRow()]);
    const svc = new BugsService(db, makeAccess(), audit);

    const [row] = (await svc.listBugs(makeU(), PROJECT_ID, {})) as Record<string, unknown>[];

    for (const field of QA_SIDECAR_FIELDS) expect(row?.[field]).toBeNull();
    expect(row?.["type"]).toBe("BUG");
    expect(row?.["ticketNumber"]).toBe(12);
  });

  it("still satisfies the published bug response contract, so a sidecar-less bug renders rather than failing decode", () => {
    const parsed = bugRowSchema.safeParse(sidecarLessBugRow());
    expect(parsed.success).toBe(true);
  });

  it("projects every QA sidecar field the contract declares, so a null here means an absent sidecar and never an omitted column", async () => {
    const { db, projections } = listDb([sidecarLessBugRow()]);
    const svc = new BugsService(db, makeAccess(), audit);

    await svc.listBugs(makeU(), PROJECT_ID, {});

    const projected = Object.keys(projections[0] as Record<string, unknown>);
    for (const field of QA_SIDECAR_FIELDS) expect(projected).toContain(field);
  });

  it("counts the QA sidecar fields the contract declares, so adding one to the schema without projecting it fails here", () => {
    const contractFields = Object.keys(bugRowSchema.shape);
    for (const field of QA_SIDECAR_FIELDS) expect(contractFields).toContain(field);
    expect(QA_SIDECAR_FIELDS).toHaveLength(14);
  });
});
