import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { AccessService } from "../../../access/access.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import {
  MEMBER_STANDING,
  projectAccessRow,
  standingAccess,
  type ProjectAccessRow,
} from "../project-crud/__tests__/project-access-doubles";
import { ProjectsCustomFieldsService } from "./projects-custom-fields.service";
import { createCustomFieldSchema } from "../dto/custom-fields.schemas";

const PROJECT_ID = 7;
const FIELD_ID = 3;

const actor: CurrentUserContext = {
  userId: "user-21",
  orgId: "org-1",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "s",
  tokenScopes: null,
  principal: humanSessionPrincipal(21, false),
};

const fieldRow = {
  id: FIELD_ID,
  orgId: "org-1",
  projectId: PROJECT_ID,
  label: "Severity",
  fieldType: "text",
  options: null,
  isRequired: false,
  displayOrder: 0,
  createdAt: new Date(0),
};

function makeDb(project: ProjectAccessRow | null) {
  const projectRows = project === null ? [] : [project];
  const listChain = {
    from: () => listChain,
    where: () => listChain,
    orderBy: () => Promise.resolve([fieldRow]),
  };
  const select = jest.fn((fields?: object) =>
    fields !== undefined && "memberRole" in fields
      ? { from: () => ({ where: () => ({ limit: () => Promise.resolve(projectRows) }) }) }
      : listChain,
  );
  const returning = jest.fn(() => ({ catch: () => Promise.resolve([fieldRow]) }));
  const writeChain = { values: () => ({ returning }), set: () => writeChain, where: () => ({ returning }) };
  const insert = jest.fn(() => writeChain);
  const update = jest.fn(() => writeChain);
  const remove = jest.fn(() => ({ where: () => ({ returning: () => Promise.resolve([fieldRow]) }) }));
  return { select, insert, update, delete: remove };
}

async function build(project: ProjectAccessRow | null) {
  const db = makeDb(project);
  const moduleRef = await Test.createTestingModule({
    providers: [
      ProjectsCustomFieldsService,
      { provide: DRIZZLE, useValue: db },
      { provide: AccessService, useValue: standingAccess(MEMBER_STANDING) },
    ],
  }).compile();
  return { db, svc: moduleRef.get(ProjectsCustomFieldsService) };
}

type Built = Awaited<ReturnType<typeof build>>;

const WRITES: Array<[string, (built: Built) => Promise<unknown>]> = [
  [
    "POST /build/:projectId/custom-fields",
    ({ svc }) => svc.createField(actor, PROJECT_ID, createCustomFieldSchema.parse({ name: "Severity", type: "text" })),
  ],
  ["PATCH /build/:projectId/custom-fields/:fieldId", ({ svc }) => svc.updateField(actor, PROJECT_ID, FIELD_ID, { name: "Impact" })],
  ["DELETE /build/:projectId/custom-fields/:fieldId", ({ svc }) => svc.deleteField(actor, PROJECT_ID, FIELD_ID)],
];

function wrote(built: Built): boolean {
  return (
    built.db.insert.mock.calls.length > 0 ||
    built.db.update.mock.calls.length > 0 ||
    built.db.delete.mock.calls.length > 0
  );
}

describe("custom field definitions are decided by the project-access rule", () => {
  it.each(WRITES)("%s answers 403 to a same-org member who does not manage the project, before any write", async (_route, call) => {
    const built = await build(projectAccessRow({ memberRole: "MEMBER" }));
    await expect(call(built)).rejects.toThrow(ForbiddenException);
    expect(wrote(built)).toBe(false);
  });

  it.each(WRITES)("%s answers 403 to a same-org caller with no relationship to the project", async (_route, call) => {
    const built = await build(projectAccessRow());
    await expect(call(built)).rejects.toThrow(ForbiddenException);
    expect(wrote(built)).toBe(false);
  });

  it.each(WRITES)("%s answers 404 for a project outside the caller's organisation", async (_route, call) => {
    const built = await build(null);
    await expect(call(built)).rejects.toThrow(NotFoundException);
    expect(wrote(built)).toBe(false);
  });

  it.each(WRITES)("%s answers 409 PROJECT_LOCKED on an archived project the caller manages", async (_route, call) => {
    const built = await build(projectAccessRow({ manages: true, state: "ARCHIVED" }));
    await expect(call(built)).rejects.toThrow(ConflictException);
    expect(wrote(built)).toBe(false);
  });

  it.each(WRITES)("%s succeeds for the project's manager", async (_route, call) => {
    const built = await build(projectAccessRow({ manages: true }));
    await expect(call(built)).resolves.toBeDefined();
    expect(wrote(built)).toBe(true);
  });

  it("GET /build/:projectId/custom-fields conceals a same-org project the caller does not reach as 404", async () => {
    const { svc } = await build(projectAccessRow());
    await expect(svc.listFields(actor, PROJECT_ID)).rejects.toThrow(NotFoundException);
  });

  it("GET /build/:projectId/custom-fields answers 404 for a project outside the caller's organisation", async () => {
    const { svc } = await build(null);
    await expect(svc.listFields(actor, PROJECT_ID)).rejects.toThrow(NotFoundException);
  });

  it("GET /build/:projectId/custom-fields lists the definitions for a project member", async () => {
    const { svc } = await build(projectAccessRow({ memberRole: "MEMBER" }));
    await expect(svc.listFields(actor, PROJECT_ID)).resolves.toEqual([
      expect.objectContaining({ id: FIELD_ID, name: "Severity", projectId: PROJECT_ID }),
    ]);
  });
});
