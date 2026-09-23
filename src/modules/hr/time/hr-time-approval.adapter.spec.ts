import { HrTimeApprovalAdapter } from "./hr-time-approval.adapter";
import { ApprovalAdapterRegistry } from "../../attention/approval-adapter.registry";

function makeLeaveRow(overrides: Partial<{
  id: number;
  startDate: string;
  endDate: string;
  createdAt: Date;
  leaveTypeName: string | null;
  userId: string | null;
  userName: string | null;
  userFirstName: string | null;
  userLastName: string | null;
  userImage: string | null;
}> = {}) {
  return {
    id: 1,
    startDate: "2026-10-01",
    endDate: "2026-10-03",
    createdAt: new Date("2026-09-20T00:00:00Z"),
    leaveTypeName: "Casual Leave",
    userId: "user-1",
    userName: "Alice Smith",
    userFirstName: "Alice",
    userLastName: "Smith",
    userImage: null,
    ...overrides,
  };
}

function makeWfhRow(overrides: Partial<{
  id: number;
  userId: string;
  date: string;
  reason: string | null;
  createdAt: Date;
  userName: string | null;
  userFirstName: string | null;
  userLastName: string | null;
  userEmail: string;
}> = {}) {
  return {
    id: 10,
    userId: "user-2",
    date: "2026-10-05",
    reason: null,
    createdAt: new Date("2026-09-21T00:00:00Z"),
    userName: "Bob Jones",
    userFirstName: "Bob",
    userLastName: "Jones",
    userEmail: "bob@example.com",
    ...overrides,
  };
}

function makeLeaves(rows: ReturnType<typeof makeLeaveRow>[] = [makeLeaveRow()], pendingCount = 1) {
  return {
    pendingRoutedToPage: jest.fn().mockResolvedValue(rows),
    countPendingRoutedTo: jest.fn().mockResolvedValue(pendingCount),
  } as unknown as import("./leaves.service").LeavesService;
}

function makeWfh(rows: ReturnType<typeof makeWfhRow>[] = [makeWfhRow()], pendingCount = 1) {
  return {
    pendingRoutedToPage: jest.fn().mockResolvedValue(rows),
    countPendingRoutedTo: jest.fn().mockResolvedValue(pendingCount),
  } as unknown as import("./wfh.service").WfhService;
}

function makeRegistry() {
  return new ApprovalAdapterRegistry();
}

describe("HrTimeApprovalAdapter — onModuleInit", () => {
  it("registers a leave adapter with permission hr:leaves:approve", () => {
    const registry = makeRegistry();
    const adapter = new HrTimeApprovalAdapter(makeLeaves(), makeWfh(), registry);
    adapter.onModuleInit();
    const adapters = registry.list();
    const leave = adapters.find((a) => a.kindLabel === "leave");
    expect(leave?.permission).toBe("hr:leaves:approve");
  });

  it("registers a wfh adapter with permission hr:attendance:manage", () => {
    const registry = makeRegistry();
    const adapter = new HrTimeApprovalAdapter(makeLeaves(), makeWfh(), registry);
    adapter.onModuleInit();
    const wfh = registry.list().find((a) => a.kindLabel === "wfh");
    expect(wfh?.permission).toBe("hr:attendance:manage");
  });

  it("both adapters have supportsAfterCursor = true so the merge keeps paging them past page 1", () => {
    const registry = makeRegistry();
    const adapter = new HrTimeApprovalAdapter(makeLeaves(), makeWfh(), registry);
    adapter.onModuleInit();
    expect(registry.list()).toHaveLength(2);
    for (const a of registry.list()) {
      expect(a.supportsAfterCursor).toBe(true);
    }
  });

  it("is idempotent: double init registers each adapter only once", () => {
    const registry = makeRegistry();
    const adapter = new HrTimeApprovalAdapter(makeLeaves(), makeWfh(), registry);
    adapter.onModuleInit();
    adapter.onModuleInit();
    expect(registry.list()).toHaveLength(2);
  });
});

describe("HrTimeApprovalAdapter — leave fetch", () => {
  it("returns empty array when membershipId is null", async () => {
    const leaves = makeLeaves();
    const registry = makeRegistry();
    const adapter = new HrTimeApprovalAdapter(leaves, makeWfh(), registry);
    adapter.onModuleInit();
    const leaveAdapter = registry.list().find((a) => a.kindLabel === "leave")!;
    const result = await leaveAdapter.fetch("org-1", "user-1", null, 10, null);
    expect(result).toHaveLength(0);
    expect(leaves.pendingRoutedToPage).not.toHaveBeenCalled();
  });

  it("maps leave row to BuildApprovalInboxItem with collision-free dedupKey", async () => {
    const leaves = makeLeaves([makeLeaveRow({ id: 7 })]);
    const registry = makeRegistry();
    const adapter = new HrTimeApprovalAdapter(leaves, makeWfh(), registry);
    adapter.onModuleInit();
    const leaveAdapter = registry.list().find((a) => a.kindLabel === "leave")!;
    const [item] = await leaveAdapter.fetch("org-1", "user-1", 5, 10, null);
    expect(item?.kind).toBe("build_approval");
    expect(item?.approvalKind).toBe("leave");
    expect(item?.dedupKey).toBe("approval:leave:7");
  });

  it("constructs subject from leaveType.name and date range", async () => {
    const leaves = makeLeaves([makeLeaveRow()]);
    const registry = makeRegistry();
    const adapter = new HrTimeApprovalAdapter(leaves, makeWfh(), registry);
    adapter.onModuleInit();
    const leaveAdapter = registry.list().find((a) => a.kindLabel === "leave")!;
    const [item] = await leaveAdapter.fetch("org-1", "user-1", 5, 10, null);
    expect(item?.subject).toBe("Casual Leave · 2026-10-01 to 2026-10-03");
  });

  it("falls back to 'Leave' in subject when leaveType is null", async () => {
    const leaves = makeLeaves([makeLeaveRow({ leaveTypeName: null })]);
    const registry = makeRegistry();
    const adapter = new HrTimeApprovalAdapter(leaves, makeWfh(), registry);
    adapter.onModuleInit();
    const leaveAdapter = registry.list().find((a) => a.kindLabel === "leave")!;
    const [item] = await leaveAdapter.fetch("org-1", "user-1", 5, 10, null);
    expect(item?.subject).toMatch(/^Leave ·/);
  });

  it("passes orgId and membershipId to pendingRoutedToPage (tenant isolation)", async () => {
    const leaves = makeLeaves();
    const registry = makeRegistry();
    const adapter = new HrTimeApprovalAdapter(leaves, makeWfh(), registry);
    adapter.onModuleInit();
    const leaveAdapter = registry.list().find((a) => a.kindLabel === "leave")!;
    await leaveAdapter.fetch("org-99", "user-1", 42, 25, null);
    expect(leaves.pendingRoutedToPage).toHaveBeenCalledWith("org-99", 42, 25, null);
  });

  it("hands the leave cursor through to pendingRoutedToPage unchanged", async () => {
    const leaves = makeLeaves();
    const registry = makeRegistry();
    const adapter = new HrTimeApprovalAdapter(leaves, makeWfh(), registry);
    adapter.onModuleInit();
    const leaveAdapter = registry.list().find((a) => a.kindLabel === "leave")!;
    const cursor = { id: 7, t: "2026-09-20T00:00:00.000Z" };
    await leaveAdapter.fetch("org-99", "user-1", 42, 25, cursor);
    expect(leaves.pendingRoutedToPage).toHaveBeenCalledWith("org-99", 42, 25, cursor);
  });
});

describe("HrTimeApprovalAdapter — wfh fetch", () => {
  it("returns empty array when membershipId is null", async () => {
    const wfh = makeWfh();
    const registry = makeRegistry();
    const adapter = new HrTimeApprovalAdapter(makeLeaves(), wfh, registry);
    adapter.onModuleInit();
    const wfhAdapter = registry.list().find((a) => a.kindLabel === "wfh")!;
    const result = await wfhAdapter.fetch("org-1", "user-1", null, 10, null);
    expect(result).toHaveLength(0);
    expect(wfh.pendingRoutedToPage).not.toHaveBeenCalled();
  });

  it("maps wfh row to BuildApprovalInboxItem with collision-free dedupKey", async () => {
    const wfh = makeWfh([makeWfhRow({ id: 55 })]);
    const registry = makeRegistry();
    const adapter = new HrTimeApprovalAdapter(makeLeaves(), wfh, registry);
    adapter.onModuleInit();
    const wfhAdapter = registry.list().find((a) => a.kindLabel === "wfh")!;
    const [item] = await wfhAdapter.fetch("org-1", "user-1", 5, 10, null);
    expect(item?.dedupKey).toBe("approval:wfh:55");
    expect(item?.approvalKind).toBe("wfh");
  });

  it("wfh and leave dedup keys do not collide at same numeric id", async () => {
    const leaves = makeLeaves([makeLeaveRow({ id: 9 })]);
    const wfh = makeWfh([makeWfhRow({ id: 9 })]);
    const registry = makeRegistry();
    const adapter = new HrTimeApprovalAdapter(leaves, wfh, registry);
    adapter.onModuleInit();
    const [leaveAdapter, wfhAdapter] = registry.list();
    const [l] = await leaveAdapter!.fetch("org-1", "u", 1, 10, null);
    const [w] = await wfhAdapter!.fetch("org-1", "u", 1, 10, null);
    expect(l?.dedupKey).not.toBe(w?.dedupKey);
  });

  it("passes orgId and membershipId to pendingRoutedToPage (tenant isolation)", async () => {
    const wfh = makeWfh();
    const registry = makeRegistry();
    const adapter = new HrTimeApprovalAdapter(makeLeaves(), wfh, registry);
    adapter.onModuleInit();
    const wfhAdapter = registry.list().find((a) => a.kindLabel === "wfh")!;
    await wfhAdapter.fetch("org-77", "user-1", 12, 25, null);
    expect(wfh.pendingRoutedToPage).toHaveBeenCalledWith("org-77", 12, 25, null);
  });

  it("hands the wfh cursor through to pendingRoutedToPage unchanged", async () => {
    const wfh = makeWfh();
    const registry = makeRegistry();
    const adapter = new HrTimeApprovalAdapter(makeLeaves(), wfh, registry);
    adapter.onModuleInit();
    const wfhAdapter = registry.list().find((a) => a.kindLabel === "wfh")!;
    const cursor = { id: 55, t: "2026-09-21T00:00:00.000Z" };
    await wfhAdapter.fetch("org-77", "user-1", 12, 25, cursor);
    expect(wfh.pendingRoutedToPage).toHaveBeenCalledWith("org-77", 12, 25, cursor);
  });
});

describe("HrTimeApprovalAdapter — leave deepLink", () => {
  it("every leave item carries deepLink /hr/leaves?tab=pending", async () => {
    const leaves = makeLeaves([makeLeaveRow()]);
    const registry = makeRegistry();
    const adapter = new HrTimeApprovalAdapter(leaves, makeWfh(), registry);
    adapter.onModuleInit();
    const leaveAdapter = registry.list().find((a) => a.kindLabel === "leave")!;
    const [item] = await leaveAdapter.fetch("org-1", "user-1", 5, 10, null);
    expect(item?.deepLink).toBe("/hr/leaves?tab=pending");
  });

  it("CONTROL: wfh items carry a different deepLink than leave items", async () => {
    const wfh = makeWfh([makeWfhRow()]);
    const registry = makeRegistry();
    const adapter = new HrTimeApprovalAdapter(makeLeaves(), wfh, registry);
    adapter.onModuleInit();
    const wfhAdapter = registry.list().find((a) => a.kindLabel === "wfh")!;
    const [item] = await wfhAdapter.fetch("org-1", "user-1", 5, 10, null);
    expect(item?.deepLink).not.toBe("/hr/leaves?tab=pending");
  });
});

describe("HrTimeApprovalAdapter — wfh deepLink", () => {
  it("every wfh item carries deepLink /hr/attendance", async () => {
    const wfh = makeWfh([makeWfhRow()]);
    const registry = makeRegistry();
    const adapter = new HrTimeApprovalAdapter(makeLeaves(), wfh, registry);
    adapter.onModuleInit();
    const wfhAdapter = registry.list().find((a) => a.kindLabel === "wfh")!;
    const [item] = await wfhAdapter.fetch("org-1", "user-1", 5, 10, null);
    expect(item?.deepLink).toBe("/hr/attendance");
  });

  it("CONTROL: leave items carry a different deepLink than wfh items", async () => {
    const leaves = makeLeaves([makeLeaveRow()]);
    const registry = makeRegistry();
    const adapter = new HrTimeApprovalAdapter(leaves, makeWfh(), registry);
    adapter.onModuleInit();
    const leaveAdapter = registry.list().find((a) => a.kindLabel === "leave")!;
    const [item] = await leaveAdapter.fetch("org-1", "user-1", 5, 10, null);
    expect(item?.deepLink).not.toBe("/hr/attendance");
  });
});

describe("HrTimeApprovalAdapter — leave countPending", () => {
  it("returns the count from LeavesService.countPendingRoutedTo", async () => {
    const leaves = makeLeaves([makeLeaveRow()], 4);
    const registry = makeRegistry();
    const adapter = new HrTimeApprovalAdapter(leaves, makeWfh(), registry);
    adapter.onModuleInit();
    const leaveAdapter = registry.list().find((a) => a.kindLabel === "leave")!;
    const result = await leaveAdapter.countPending("org-1", "user-1", 5);
    expect(result).toBe(4);
  });

  it("returns 0 when membershipId is null — positive case above returns non-zero, satisfying BE-141", async () => {
    const leaves = makeLeaves([makeLeaveRow()], 3);
    const registry = makeRegistry();
    const adapter = new HrTimeApprovalAdapter(leaves, makeWfh(), registry);
    adapter.onModuleInit();
    const leaveAdapter = registry.list().find((a) => a.kindLabel === "leave")!;
    const result = await leaveAdapter.countPending("org-1", "user-1", null);
    expect(result).toBe(0);
    expect(leaves.countPendingRoutedTo).not.toHaveBeenCalled();
  });

  it("passes orgId and membershipId to countPendingRoutedTo (tenant and approver isolation)", async () => {
    const leaves = makeLeaves();
    const registry = makeRegistry();
    const adapter = new HrTimeApprovalAdapter(leaves, makeWfh(), registry);
    adapter.onModuleInit();
    const leaveAdapter = registry.list().find((a) => a.kindLabel === "leave")!;
    await leaveAdapter.countPending("org-X", "user-1", 42);
    expect(leaves.countPendingRoutedTo).toHaveBeenCalledWith("org-X", 42);
    expect(leaves.countPendingRoutedTo).toHaveBeenCalledTimes(1);
  });
});

describe("HrTimeApprovalAdapter — wfh countPending", () => {
  it("returns the count from WfhService.countPendingRoutedTo", async () => {
    const wfh = makeWfh([makeWfhRow()], 7);
    const registry = makeRegistry();
    const adapter = new HrTimeApprovalAdapter(makeLeaves(), wfh, registry);
    adapter.onModuleInit();
    const wfhAdapter = registry.list().find((a) => a.kindLabel === "wfh")!;
    const result = await wfhAdapter.countPending("org-1", "user-1", 12);
    expect(result).toBe(7);
  });

  it("returns 0 when membershipId is null — positive case above returns non-zero, satisfying BE-141", async () => {
    const wfh = makeWfh([makeWfhRow()], 2);
    const registry = makeRegistry();
    const adapter = new HrTimeApprovalAdapter(makeLeaves(), wfh, registry);
    adapter.onModuleInit();
    const wfhAdapter = registry.list().find((a) => a.kindLabel === "wfh")!;
    const result = await wfhAdapter.countPending("org-1", "user-1", null);
    expect(result).toBe(0);
    expect(wfh.countPendingRoutedTo).not.toHaveBeenCalled();
  });

  it("passes orgId and membershipId to countPendingRoutedTo (tenant and approver isolation)", async () => {
    const wfh = makeWfh();
    const registry = makeRegistry();
    const adapter = new HrTimeApprovalAdapter(makeLeaves(), wfh, registry);
    adapter.onModuleInit();
    const wfhAdapter = registry.list().find((a) => a.kindLabel === "wfh")!;
    await wfhAdapter.countPending("org-Y", "user-2", 99);
    expect(wfh.countPendingRoutedTo).toHaveBeenCalledWith("org-Y", 99);
    expect(wfh.countPendingRoutedTo).toHaveBeenCalledTimes(1);
  });
});

describe("HrTimeApprovalAdapter — leave priority", () => {
  it("BITE: every leave item carries priority NORMAL (no dueAt, status pending)", async () => {
    const leaves = makeLeaves([makeLeaveRow()]);
    const registry = makeRegistry();
    const adapter = new HrTimeApprovalAdapter(leaves, makeWfh(), registry);
    adapter.onModuleInit();
    const leaveAdapter = registry.list().find((a) => a.kindLabel === "leave")!;
    const [item] = await leaveAdapter.fetch("org-1", "user-1", 5, 10, null);
    expect(item?.priority).toBe("NORMAL");
  });

  it("CONTROL: priority field is present on the returned item (not undefined)", async () => {
    const leaves = makeLeaves([makeLeaveRow()]);
    const registry = makeRegistry();
    const adapter = new HrTimeApprovalAdapter(leaves, makeWfh(), registry);
    adapter.onModuleInit();
    const leaveAdapter = registry.list().find((a) => a.kindLabel === "leave")!;
    const [item] = await leaveAdapter.fetch("org-1", "user-1", 5, 10, null);
    expect(item).toHaveProperty("priority");
  });
});

describe("HrTimeApprovalAdapter — wfh priority", () => {
  it("BITE: every wfh item carries priority NORMAL (no dueAt, status pending)", async () => {
    const wfh = makeWfh([makeWfhRow()]);
    const registry = makeRegistry();
    const adapter = new HrTimeApprovalAdapter(makeLeaves(), wfh, registry);
    adapter.onModuleInit();
    const wfhAdapter = registry.list().find((a) => a.kindLabel === "wfh")!;
    const [item] = await wfhAdapter.fetch("org-1", "user-1", 5, 10, null);
    expect(item?.priority).toBe("NORMAL");
  });

  it("CONTROL: priority field is present on the returned wfh item (not undefined)", async () => {
    const wfh = makeWfh([makeWfhRow()]);
    const registry = makeRegistry();
    const adapter = new HrTimeApprovalAdapter(makeLeaves(), wfh, registry);
    adapter.onModuleInit();
    const wfhAdapter = registry.list().find((a) => a.kindLabel === "wfh")!;
    const [item] = await wfhAdapter.fetch("org-1", "user-1", 5, 10, null);
    expect(item).toHaveProperty("priority");
  });
});
