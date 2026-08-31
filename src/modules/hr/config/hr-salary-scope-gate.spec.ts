import { HrSalaryStructuresController } from "./hr-salary-structures.controller";
import { CRM_HR_ROLE_TEMPLATES } from "../../rbac/role-templates-crm-hr.constants";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { SalaryStructureListQuery } from "./dto/salary-structures.schemas";

type ListCall = {
  orgId: string;
  subjectUserId: string | undefined;
  actorUserId: string;
  isAdmin: boolean;
};

function build(scope: string | undefined) {
  const calls: ListCall[] = [];
  const service = {
    list: jest.fn(
      (orgId: string, subjectUserId: string | undefined, actorUserId: string, isAdmin: boolean) => {
        calls.push({ orgId, subjectUserId, actorUserId, isAdmin });
        return Promise.resolve([]);
      },
    ),
    create: jest.fn(),
  };
  const granted: Array<[string, string]> = scope === undefined ? [] : [["hr:salary:view", scope]];
  granted.push(["hr:salary:manage", "all"]);
  const access = {
    resolveUserPermissions: jest.fn(() => Promise.resolve(new Map(granted))),
  };
  const controller = new HrSalaryStructuresController(
    service as unknown as ConstructorParameters<typeof HrSalaryStructuresController>[0],
    access as unknown as ConstructorParameters<typeof HrSalaryStructuresController>[1],
  );
  return { controller, calls, access };
}

const ACTOR: CurrentUserContext = {
  userId: "actor-1",
  orgId: "org-1",
  isOrgOwner: false,
} as CurrentUserContext;

const OTHER_PERSON: SalaryStructureListQuery = {
  userId: "victim-2",
} as SalaryStructureListQuery;

describe("hr:salary subject filter cannot be widened by a plain viewer", () => {
  it("models the real grant shape: every caller here also holds hr:salary:manage", async () => {
    const { access } = build("own");
    const perms = await access.resolveUserPermissions();

    expect(perms.has("hr:salary:manage")).toBe(true);
  });

  it("forces the subject to the caller when the read scope is own", async () => {
    const { controller, calls } = build("own");

    await controller.list(OTHER_PERSON, ACTOR);

    expect(calls[0]?.subjectUserId).toBe("actor-1");
    expect(calls[0]?.isAdmin).toBe(false);
  });

  it("forces the subject to the caller when the read scope is team", async () => {
    const { controller, calls } = build("team");

    await controller.list(OTHER_PERSON, ACTOR);

    expect(calls[0]?.subjectUserId).toBe("actor-1");
  });

  it("forces the subject to the caller when the key resolves to no scope at all", async () => {
    const { controller, calls } = build(undefined);

    await controller.list(OTHER_PERSON, ACTOR);

    expect(calls[0]?.subjectUserId).toBe("actor-1");
    expect(calls[0]?.isAdmin).toBe(false);
  });

  it("honours a widened subject only for an all-scope holder", async () => {
    const { controller, calls } = build("all");

    await controller.list(OTHER_PERSON, ACTOR);

    expect(calls[0]?.subjectUserId).toBe("victim-2");
    expect(calls[0]?.isAdmin).toBe(true);
  });

  it("treats the org owner as all-scope without consulting the key", async () => {
    const { controller, calls } = build("own");

    await controller.list(OTHER_PERSON, { ...ACTOR, isOrgOwner: true });

    expect(calls[0]?.subjectUserId).toBe("victim-2");
    expect(calls[0]?.isAdmin).toBe(true);
  });

  it("proves gating on hr:salary:manage would be a no-op, because it is co-granted with view", () => {
    const templatesGrantingView = CRM_HR_ROLE_TEMPLATES.filter((template) =>
      template.permissions.includes("hr:salary:view"),
    );

    expect(templatesGrantingView.length).toBeGreaterThan(0);
    for (const template of templatesGrantingView)
      expect(template.permissions).toContain("hr:salary:manage");
  });
});
