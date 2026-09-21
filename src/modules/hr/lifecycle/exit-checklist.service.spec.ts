import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import type { DataScope } from "../../access/access.types";
import { ExitChecklistService } from "./exit-checklist.service";

const ORG = "org-exit-checklist";
const RESIGNATION = { id: 7, userId: "leaver", userMembershipId: 70, status: "FINAL_APPROVED", lastWorkingDate: "2026-10-31", noticePeriodDays: 30, createdAt: new Date("2026-09-21T00:00:00Z") };

function itemRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 501,
    itemKey: "asset_return",
    item: "Company assets returned and recorded",
    status: "PENDING",
    dueDate: "2026-10-31",
    assignedToMembershipId: null,
    ownerQueue: "hr:assets:manage",
    completedAt: null,
    completedByMembershipId: null,
    evidence: null,
    notes: null,
    updatedAt: new Date("2026-09-21T00:00:00Z"),
    assigneeUserId: null,
    assigneeName: null,
    assigneeEmail: null,
    completerName: null,
    ...overrides,
  };
}

function chain(result: unknown[]) {
  const builder: Record<string, unknown> = {};
  for (const step of ["from", "where", "leftJoin", "orderBy", "limit"]) builder[step] = () => builder;
  builder["then"] = (resolve: (value: unknown[]) => unknown) => Promise.resolve(result).then(resolve);
  return builder;
}

function buildService(selects: unknown[][], held: Record<string, DataScope> = {}) {
  const queue = [...selects];
  const set = jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) });
  const db = {
    select: jest.fn().mockImplementation(() => chain(queue.shift() ?? [])),
    selectDistinct: jest.fn().mockImplementation(() => chain(queue.shift() ?? [])),
    update: jest.fn().mockReturnValue({ set }),
  } as unknown as Db;
  const access = { resolveUserPermissions: jest.fn().mockResolvedValue(new Map(Object.entries(held))) };
  const hrAudit = { log: jest.fn().mockResolvedValue(undefined) };
  const approvals = { resolve: jest.fn() };
  const service = new ExitChecklistService(db, approvals as never, access as never, hrAudit as never);
  return { service, set, hrAudit, access };
}

const admin = { userId: "hr-admin", membershipId: 1, isAdmin: true };
const stranger = { userId: "someone", membershipId: 99, isAdmin: false };

describe("ExitChecklistService.updateItem — a permission-checked, audited write on one checklist item", () => {
  it("answers 404 for a resignation outside the caller's organisation, never confirming it exists", async () => {
    const { service, set } = buildService([[]]);

    await expect(service.updateItem(ORG, admin, 7, "asset_return", { status: "DONE", evidence: "x" })).rejects.toBeInstanceOf(NotFoundException);
    expect(set).not.toHaveBeenCalled();
  });

  it("answers 404 for an item key the resignation does not carry", async () => {
    const { service } = buildService([[RESIGNATION], []]);

    await expect(service.updateItem(ORG, admin, 7, "made_up", { notes: "n" })).rejects.toBeInstanceOf(NotFoundException);
  });

  it("lets an exit administrator close an item with evidence and audits who closed it", async () => {
    const closed = itemRow({ status: "DONE", evidence: "Laptop returned, tag AS-19", completedByMembershipId: 1, completedAt: new Date("2026-09-22T00:00:00Z"), completerName: "HR Admin" });
    const { service, set, hrAudit } = buildService([[RESIGNATION], [itemRow()], [closed]]);

    const result = await service.updateItem(ORG, admin, 7, "asset_return", { status: "DONE", evidence: "Laptop returned, tag AS-19" });

    expect(result).toMatchObject({ itemKey: "asset_return", kind: "asset_return", status: "DONE", viewerCanUpdate: true, completedBy: { membershipId: 1, name: "HR Admin" } });
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ status: "DONE", evidence: "Laptop returned, tag AS-19", completedByMembershipId: 1 }));
    expect(hrAudit.log).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG, actorId: "hr-admin", actorMembershipId: 1, entityType: "exit_checklists", entityId: "501", action: "exit_checklist_item_updated" }));
  });

  it("lets a queue member close an item their queue owns, but not reassign it", async () => {
    const assetsOwner = { userId: "assets-lead", membershipId: 33, isAdmin: false };
    const { service, set } = buildService([[RESIGNATION], [itemRow()], [itemRow({ status: "WAIVED" })]], { "hr:assets:manage": "all" });

    await expect(service.updateItem(ORG, assetsOwner, 7, "asset_return", { status: "WAIVED", evidence: "No assets were ever issued" })).resolves.toMatchObject({ status: "WAIVED" });
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ status: "WAIVED" }));

    const again = buildService([[RESIGNATION], [itemRow()]], { "hr:assets:manage": "all" });
    await expect(again.service.updateItem(ORG, assetsOwner, 7, "asset_return", { ownerQueue: "hr:exit:manage" })).rejects.toBeInstanceOf(ForbiddenException);
    expect(again.set).not.toHaveBeenCalled();
  });

  it("lets the assigned person close their own item", async () => {
    const manager = { userId: "manager", membershipId: 44, isAdmin: false };
    const owned = itemRow({ itemKey: "manager_handover", assignedToMembershipId: 44, ownerQueue: null, assigneeUserId: "manager", assigneeEmail: "m@x.test" });
    const { service, set } = buildService([[RESIGNATION], [owned], [{ ...owned, status: "DONE" }]]);

    await expect(service.updateItem(ORG, manager, 7, "manager_handover", { status: "DONE", evidence: "Handover doc shared" })).resolves.toMatchObject({ status: "DONE", owner: { type: "member", membershipId: 44 } });
    expect(set).toHaveBeenCalled();
  });

  it("refuses a member who neither owns the item nor holds its queue permission", async () => {
    const { service, set } = buildService([[RESIGNATION], [itemRow()]], { "hr:exit:view": "own" });

    await expect(service.updateItem(ORG, stranger, 7, "asset_return", { status: "DONE", evidence: "x" })).rejects.toBeInstanceOf(ForbiddenException);
    expect(set).not.toHaveBeenCalled();
  });

  it("freezes the checklist once the exit is complete", async () => {
    const { service, set } = buildService([[{ ...RESIGNATION, status: "COMPLETED" }], [itemRow()]]);

    await expect(service.updateItem(ORG, admin, 7, "asset_return", { notes: "late note" })).rejects.toBeInstanceOf(BadRequestException);
    expect(set).not.toHaveBeenCalled();
  });

  it("reopening an item clears who closed it", async () => {
    const done = itemRow({ status: "DONE", completedByMembershipId: 1, completedAt: new Date() });
    const { service, set } = buildService([[RESIGNATION], [done], [itemRow()]]);

    await service.updateItem(ORG, admin, 7, "asset_return", { status: "PENDING" });

    expect(set).toHaveBeenCalledWith(expect.objectContaining({ status: "PENDING", completedAt: null, completedByMembershipId: null }));
  });
});

describe("ExitChecklistService.listForResignation — the viewer sees who owns what and which action is theirs", () => {
  it("orders typed items in lifecycle order before custom ones, names each owner and counts open, done, waived and overdue", async () => {
    const rows = [
      itemRow({ id: 3, itemKey: "custom-ab12", item: "Return parking pass", ownerQueue: "hr:exit:manage", dueDate: "2000-01-01" }),
      itemRow({ id: 2, itemKey: "final_settlement", status: "WAIVED", ownerQueue: "hr:payroll:approve" }),
      itemRow({ id: 1, itemKey: "manager_handover", status: "DONE", assignedToMembershipId: 44, ownerQueue: null, assigneeUserId: "manager", assigneeName: "Mia", assigneeEmail: "mia@x.test" }),
      itemRow({ id: 4, itemKey: "it_access_removal", ownerQueue: "hr:identity:manage" }),
    ];
    const { service } = buildService([rows], { "hr:identity:manage": "all" });

    const checklist = await service.listForResignation(ORG, 7, stranger);

    expect(checklist.items.map((item) => item.itemKey)).toEqual(["manager_handover", "it_access_removal", "final_settlement", "custom-ab12"]);
    expect(checklist.items[0]?.owner).toEqual({ type: "member", membershipId: 44, userId: "manager", name: "Mia", email: "mia@x.test" });
    expect(checklist.items[1]).toMatchObject({ owner: { type: "queue", permission: "hr:identity:manage", label: "Identity & access queue" }, viewerCanUpdate: true });
    expect(checklist.items[3]).toMatchObject({ kind: "custom", viewerCanUpdate: false });
    expect(checklist.summary).toEqual({ total: 4, open: 2, done: 1, waived: 1, overdue: 1 });
  });

  it("never leaves an item unowned: a row with neither assignee nor a known queue belongs to the HR exits queue", async () => {
    const { service } = buildService([[itemRow({ assignedToMembershipId: null, ownerQueue: null })]]);

    const checklist = await service.listForResignation(ORG, 7, admin);

    expect(checklist.items[0]?.owner).toEqual({ type: "queue", permission: "hr:exit:manage", label: "HR exits queue" });
  });
});
