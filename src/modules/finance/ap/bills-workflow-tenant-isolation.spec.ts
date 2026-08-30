import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { BillsWorkflowService } from "./bills-workflow.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

jest.mock("../../../common/organization/organization-actor", () => ({
  assertOrganizationActor: jest.fn().mockResolvedValue({
    orgId: "org-owner",
    userId: "user-1",
    membershipId: 1,
    role: "MEMBER",
    isOwner: false,
    resolvedVia: "user",
    organizationPersonId: null,
  }),
}));

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

describe("BillsWorkflowService — cross-tenant isolation", () => {
  const ATTACKER_ORG = "org-attacker";
  const OWNER_ORG = "org-owner";

  function makeUser(orgId: string): CurrentUserContext {
    return { orgId, userId: "user-1", membershipId: 1, role: "MEMBER", isOwner: false } as never;
  }

  it("throws NotFoundException when the bill belongs to a different org (BOLA isolation)", async () => {
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
        }),
      }),
    } as unknown as Db;
    const svc = new BillsWorkflowService(db, {} as never, {} as never, {} as never, {} as never);

    await expect(svc.submitForApproval(makeUser(ATTACKER_ORG), 999, { note: "test" })).rejects.toThrow(NotFoundException);
  });

  it("does not throw NotFoundException for a bill owned by the same org (same-tenant control)", async () => {
    const bill = { id: 1, orgId: OWNER_ORG, status: "DRAFT", total: "1000.00" };
    let call = 0;
    const db = {
      select: jest.fn().mockImplementation(() => {
        call++;
        const rows = call === 1 ? [bill] : [{ needsApproval: false }];
        return { from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(rows) }) }) };
      }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([bill]) }),
      }),
    } as unknown as Db;
    const audit = { log: jest.fn().mockResolvedValue(undefined) } as never;
    const dispatch = { emit: jest.fn().mockResolvedValue(undefined) } as never;
    const svc = new BillsWorkflowService(db, audit, dispatch, {} as never, {} as never);

    const err = await svc.submitForApproval(makeUser(OWNER_ORG), 1, { note: "test" }).catch(e => e);

    expect(err).not.toBeInstanceOf(NotFoundException);
  });
});
