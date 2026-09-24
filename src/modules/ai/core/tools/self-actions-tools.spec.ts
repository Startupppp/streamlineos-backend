import { z } from "zod";
import { SelfActionsTools } from "./self-actions-tools";
import { AiConfirmationService } from "../../confirmation/ai-confirmation.service";
import type { AskOsActor } from "../services/ask-os-actor";
import type { AskOsToolRunContext } from "../registry/ask-os-tool.types";
import { ScopedRead } from "../../../access/scoped-read";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { ModuleRef } from "@nestjs/core";
import { type Db } from "../../../../db/drizzle.module";

const BANNED_SUBJECT_KEYS: readonly string[] = [
  "userId",
  "orgId",
  "membershipId",
  "actorId",
  "createdById",
  "authorId",
];

const MOCK_PROPOSAL_RESULT = {
  proposalId: 99,
  token: "fake.epoch.hmac",
  expiresAt: new Date("2026-09-19T13:00:00Z"),
};

function makeMockConfirmation(): AiConfirmationService {
  return {
    propose: jest.fn().mockResolvedValue(MOCK_PROPOSAL_RESULT),
  } as unknown as AiConfirmationService;
}

function makeActor(overrides: Partial<AskOsActor> = {}): AskOsActor {
  return {
    userId: "user-abc",
    orgId: "org-xyz",
    membershipId: 7,
    displayName: "Test User",
    email: "test@example.com",
    orgName: "Test Org",
    role: "MEMBER",
    isOrgOwner: false,
    timezone: "UTC",
    today: "2026-09-19",
    monthStart: "2026-09-01",
    monthEnd: "2026-09-30",
    currentYear: 2026,
    currentMonth: 9,
    ...overrides,
  };
}

function makeCaller(): CurrentUserContext {
  return {
    userId: "user-abc",
    orgId: "org-xyz",
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "session-1",
    tokenScopes: null,
    principal: { kind: "human-session", membershipId: 7, isOrgOwner: false },
  };
}

function makeCtx(overrides: Partial<AskOsToolRunContext> = {}): AskOsToolRunContext {
  const actor = makeActor();
  const read = ScopedRead.of(actor.orgId, actor.userId, "all");
  return {
    actor,
    caller: makeCaller(),
    read,
    readFor: () => read,
    modules: {},
    ...overrides,
  };
}


function makeMockDb(leaveTypeRows: Array<{ id: number; name: string }> = [{ id: 7, name: "Casual Leave" }]): Db {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(leaveTypeRows),
  };
  return { select: () => chain } as unknown as Db;
}

function makeMockModuleRef(attendance: unknown = null): ModuleRef {
  return { get: jest.fn().mockReturnValue(attendance) } as unknown as ModuleRef;
}

describe("SelfActionsTools — schema invariants", () => {
  it("no tool input schema accepts a subject identifier", () => {
    const service = new SelfActionsTools(makeMockDb(), makeMockConfirmation(), makeMockModuleRef());
    for (const tool of service.tools()) {
      const zodObject = tool.input as z.ZodObject<z.ZodRawShape>;
      if (typeof zodObject.shape !== "object") continue;
      for (const banned of BANNED_SUBJECT_KEYS) {
        expect(Object.keys(zodObject.shape)).not.toContain(banned);
      }
    }
  });

  it("all tools have unique keys", () => {
    const service = new SelfActionsTools(makeMockDb(), makeMockConfirmation(), makeMockModuleRef());
    const keys = service.tools().map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("all Group B tools declare a permission", () => {
    const service = new SelfActionsTools(makeMockDb(), makeMockConfirmation(), makeMockModuleRef());
    for (const tool of service.tools()) {
      expect(tool.permission).toBeDefined();
    }
  });
});

describe("SelfActionsTools — Group B: applyForLeave", () => {
  it("returns needs-confirmation and does not execute the write", async () => {
    const confirmation = makeMockConfirmation();
    const service = new SelfActionsTools(makeMockDb(), confirmation, makeMockModuleRef());
    const tool = service.tools().find((t) => t.key === "applyForLeave");
    if (!tool) throw new Error("applyForLeave tool not found");

    const outcome = await tool.run(
      { leaveType: "Casual Leave", startDate: "2026-10-01", endDate: "2026-10-03" },
      makeCtx(),
    );

    expect(outcome.kind).toBe("needs-confirmation");
    if (outcome.kind === "needs-confirmation") {
      expect(outcome.action).toBe("self.applyLeave");
      expect(outcome.proposalId).toBe(99);
    }
    expect(confirmation.propose).toHaveBeenCalledTimes(1);
    expect(confirmation.propose).toHaveBeenCalledWith(
      expect.objectContaining({ action: "self.applyLeave", orgId: "org-xyz", userId: "user-abc" }),
    );
  });

  it("derives idempotency key from org + user + action + today + leave fields, not from caller input", async () => {
    const confirmation = makeMockConfirmation();
    const service = new SelfActionsTools(makeMockDb(), confirmation, makeMockModuleRef());
    const tool = service.tools().find((t) => t.key === "applyForLeave")!;

    await tool.run(
      { leaveType: "Casual Leave", startDate: "2026-10-05", endDate: "2026-10-06" },
      makeCtx(),
    );

    const call = (confirmation.propose as jest.Mock).mock.calls[0]?.[0] as { idempotencyKey: string };
    expect(call.idempotencyKey).toContain("org-xyz");
    expect(call.idempotencyKey).toContain("user-abc");
    expect(call.idempotencyKey).toContain("2026-09-19");
  });

  it("takes the leave type by name, because no tool hands the model a leave type id to pass", () => {
    const service = new SelfActionsTools(makeMockDb(), makeMockConfirmation(), makeMockModuleRef());
    const tool = service.tools().find((t) => t.key === "applyForLeave")!;
    const shape = (tool.input as z.ZodObject<z.ZodRawShape>).shape;

    expect(Object.keys(shape)).toContain("leaveType");
    expect(Object.keys(shape)).not.toContain("leaveTypeId");
  });

  it("resolves the name to the real numeric id the confirm handler requires, never the model's guess", async () => {
    const confirmation = makeMockConfirmation();
    const service = new SelfActionsTools(
      makeMockDb([{ id: 42, name: "Casual Leave" }]),
      confirmation,
      makeMockModuleRef(),
    );
    const tool = service.tools().find((t) => t.key === "applyForLeave")!;

    await tool.run(
      { leaveType: "casual leave", startDate: "2026-12-24", endDate: "2026-12-24" },
      makeCtx(),
    );

    const call = (confirmation.propose as jest.Mock).mock.calls[0]?.[0] as {
      payload: { leaveTypeId: number };
    };
    expect(call.payload.leaveTypeId).toBe(42);
  });

  it("refuses to propose against a leave type the organisation does not have, rather than inventing its id", async () => {
    const confirmation = makeMockConfirmation();
    const service = new SelfActionsTools(
      makeMockDb([]),
      confirmation,
      makeMockModuleRef(),
    );
    const tool = service.tools().find((t) => t.key === "applyForLeave")!;

    const outcome = await tool.run(
      { leaveType: "Sabbatical", startDate: "2026-12-24", endDate: "2026-12-24" },
      makeCtx(),
    );

    expect(outcome.kind).not.toBe("needs-confirmation");
    expect(confirmation.propose).not.toHaveBeenCalled();
  });
});

describe("SelfActionsTools — Group B: submitExpense", () => {
  it("returns needs-confirmation and does not execute the write", async () => {
    const confirmation = makeMockConfirmation();
    const service = new SelfActionsTools(makeMockDb(), confirmation, makeMockModuleRef());
    const tool = service.tools().find((t) => t.key === "submitExpense");
    if (!tool) throw new Error("submitExpense tool not found");

    const outcome = await tool.run(
      { amount: 50, category: "Travel", description: "Taxi to airport" },
      makeCtx(),
    );

    expect(outcome.kind).toBe("needs-confirmation");
    if (outcome.kind === "needs-confirmation") {
      expect(outcome.action).toBe("self.submitExpense");
    }
    expect(confirmation.propose).toHaveBeenCalledWith(
      expect.objectContaining({ action: "self.submitExpense" }),
    );
  });

  it("defaults expense date to ctx.actor.today when date is omitted", async () => {
    const confirmation = makeMockConfirmation();
    const service = new SelfActionsTools(makeMockDb(), confirmation, makeMockModuleRef());
    const tool = service.tools().find((t) => t.key === "submitExpense")!;

    await tool.run(
      { amount: 20, category: "Meals", description: "Team lunch" },
      makeCtx(),
    );

    const call = (confirmation.propose as jest.Mock).mock.calls[0]?.[0] as { payload: Record<string, unknown> };
    expect(call.payload["date"]).toBe("2026-09-19");
  });
});

describe("SelfActionsTools — Group B: logTimesheetEntry", () => {
  it("returns needs-confirmation and does not execute the write", async () => {
    const confirmation = makeMockConfirmation();
    const service = new SelfActionsTools(makeMockDb(), confirmation, makeMockModuleRef());
    const tool = service.tools().find((t) => t.key === "logTimesheetEntry");
    if (!tool) throw new Error("logTimesheetEntry tool not found");

    const outcome = await tool.run({ hours: 8 }, makeCtx());

    expect(outcome.kind).toBe("needs-confirmation");
    if (outcome.kind === "needs-confirmation") {
      expect(outcome.action).toBe("self.logTimesheet");
    }
    expect(confirmation.propose).toHaveBeenCalledWith(
      expect.objectContaining({ action: "self.logTimesheet" }),
    );
  });

  it("defaults entry date to ctx.actor.today when date is omitted", async () => {
    const confirmation = makeMockConfirmation();
    const service = new SelfActionsTools(makeMockDb(), confirmation, makeMockModuleRef());
    const tool = service.tools().find((t) => t.key === "logTimesheetEntry")!;

    await tool.run({ hours: 4 }, makeCtx());

    const call = (confirmation.propose as jest.Mock).mock.calls[0]?.[0] as { payload: Record<string, unknown> };
    expect(call.payload["date"]).toBe("2026-09-19");
  });
});

describe("SelfActionsTools — Group B: submitReferral", () => {
  it("returns needs-confirmation and does not execute the write", async () => {
    const confirmation = makeMockConfirmation();
    const service = new SelfActionsTools(makeMockDb(), confirmation, makeMockModuleRef());
    const tool = service.tools().find((t) => t.key === "submitReferral");
    if (!tool) throw new Error("submitReferral tool not found");

    const outcome = await tool.run(
      { candidateName: "Jane Doe", candidateEmail: "jane@example.com" },
      makeCtx(),
    );

    expect(outcome.kind).toBe("needs-confirmation");
    if (outcome.kind === "needs-confirmation") {
      expect(outcome.action).toBe("self.submitReferral");
      expect(outcome.preview["candidateName"]).toBe("Jane Doe");
    }
    expect(confirmation.propose).toHaveBeenCalledWith(
      expect.objectContaining({ action: "self.submitReferral" }),
    );
  });

  it("derives idempotency key from org + user + action + today + candidate email", async () => {
    const confirmation = makeMockConfirmation();
    const service = new SelfActionsTools(makeMockDb(), confirmation, makeMockModuleRef());
    const tool = service.tools().find((t) => t.key === "submitReferral")!;

    await tool.run(
      { candidateName: "John Smith", candidateEmail: "john@candidate.com" },
      makeCtx(),
    );

    const call = (confirmation.propose as jest.Mock).mock.calls[0]?.[0] as { idempotencyKey: string };
    expect(call.idempotencyKey).toContain("org-xyz");
    expect(call.idempotencyKey).toContain("user-abc");
    expect(call.idempotencyKey).toContain("john@candidate.com");
    expect(call.idempotencyKey).toContain("2026-09-19");
  });
});

describe("SelfActionsTools — Group B: applyToJobOpening", () => {
  it("is registered as a confirmable-write tool that requires user confirmation", () => {
    const service = new SelfActionsTools(makeMockDb(), makeMockConfirmation(), makeMockModuleRef());
    const tool = service.tools().find((t) => t.key === "applyToJobOpening");

    expect(tool).toBeDefined();
    expect(tool?.confirms).toBe("self.applyToJobOpening");
  });

  it("returns needs-confirmation and does not execute the write directly", async () => {
    const confirmation = makeMockConfirmation();
    const service = new SelfActionsTools(makeMockDb(), confirmation, makeMockModuleRef());
    const tool = service.tools().find((t) => t.key === "applyToJobOpening");
    if (!tool) throw new Error("applyToJobOpening tool not found");

    const outcome = await tool.run({ jobId: 5 }, makeCtx());

    expect(outcome.kind).toBe("needs-confirmation");
    if (outcome.kind === "needs-confirmation") {
      expect(outcome.action).toBe("self.applyToJobOpening");
      expect(outcome.proposalId).toBe(99);
    }
    expect(confirmation.propose).toHaveBeenCalledWith(
      expect.objectContaining({ action: "self.applyToJobOpening" }),
    );
  });

  it("derives orgId and userId from ctx.actor so an employee cannot apply as another", async () => {
    const confirmation = makeMockConfirmation();
    const service = new SelfActionsTools(makeMockDb(), confirmation, makeMockModuleRef());
    const tool = service.tools().find((t) => t.key === "applyToJobOpening")!;
    const ctx = makeCtx();

    await tool.run({ jobId: 3 }, ctx);

    const call = (confirmation.propose as jest.Mock).mock.calls[0]?.[0] as { orgId: string; userId: string };
    expect(call.orgId).toBe(ctx.actor.orgId);
    expect(call.userId).toBe(ctx.actor.userId);
  });

  it("includes jobId in the idempotency key so duplicate proposals for the same opening are deduplicated", async () => {
    const confirmation = makeMockConfirmation();
    const service = new SelfActionsTools(makeMockDb(), confirmation, makeMockModuleRef());
    const tool = service.tools().find((t) => t.key === "applyToJobOpening")!;

    await tool.run({ jobId: 42 }, makeCtx());

    const call = (confirmation.propose as jest.Mock).mock.calls[0]?.[0] as { idempotencyKey: string };
    expect(call.idempotencyKey).toContain("42");
    expect(call.idempotencyKey).toContain("org-xyz");
    expect(call.idempotencyKey).toContain("user-abc");
  });
});

describe("clocking is command-driven and applies immediately", () => {
  function clockCtx() {
    return makeCtx();
  }

  function attendanceDouble() {
    return {
      checkIn: jest.fn().mockResolvedValue({ ok: true }),
      checkOut: jest.fn().mockResolvedValue({ ok: true }),
      toggleBreak: jest.fn().mockResolvedValue({ ok: true }),
      status: jest.fn().mockResolvedValue({ status: "PRESENT" }),
    };
  }

  function toolNamed(attendance: unknown, key: string) {
    const service = new SelfActionsTools(makeMockDb(), makeMockConfirmation(), makeMockModuleRef(attendance));
    const found = service.tools().find((t) => t.key === key);
    if (!found) throw new Error(`missing tool ${key}`);
    return found;
  }

  it.each(["clockIn", "clockOut", "toggleBreak"])(
    "%s is offered to the model",
    (key) => {
      expect(toolNamed(attendanceDouble(), key).key).toBe(key);
    },
  );

  it.each(["clockIn", "clockOut", "toggleBreak"])(
    "%s takes no input at all, so the subject can never come from the model",
    (key) => {
      const shape = (toolNamed(attendanceDouble(), key).input as z.ZodObject<z.ZodRawShape>).shape;
      expect(Object.keys(shape)).toHaveLength(0);
    },
  );

  it("clocks in without minting a confirmation proposal", async () => {
    const attendance = attendanceDouble();
    const confirmation = makeMockConfirmation();
    const service = new SelfActionsTools(makeMockDb(), confirmation, makeMockModuleRef(attendance));
    const tool = service.tools().find((t) => t.key === "clockIn");
    const outcome = await tool?.run({}, clockCtx());

    expect(outcome).toMatchObject({ kind: "data" });
    expect(confirmation.propose).not.toHaveBeenCalled();
    expect(attendance.checkIn).toHaveBeenCalledTimes(1);
  });

  it("passes a stable per-day idempotency key so a retried turn cannot double-clock", async () => {
    const attendance = attendanceDouble();
    const service = new SelfActionsTools(makeMockDb(), makeMockConfirmation(), makeMockModuleRef(attendance));
    const tool = service.tools().find((t) => t.key === "clockIn");

    await tool?.run({}, clockCtx());
    await tool?.run({}, clockCtx());

    const firstKey = attendance.checkIn.mock.calls[0]?.[3];
    const secondKey = attendance.checkIn.mock.calls[1]?.[3];
    expect(typeof firstKey).toBe("string");
    expect(firstKey).toBe(secondKey);
  });

  it("binds the subject to the caller, never to anything the model supplied", async () => {
    const attendance = attendanceDouble();
    const service = new SelfActionsTools(makeMockDb(), makeMockConfirmation(), makeMockModuleRef(attendance));
    const tool = service.tools().find((t) => t.key === "clockOut");
    const ctx = clockCtx();

    await tool?.run({}, ctx);

    expect(attendance.checkOut).toHaveBeenCalledWith(
      ctx.actor.orgId,
      ctx.actor.userId,
      expect.any(String),
    );
  });

  it("reports a failure instead of pretending it clocked when attendance is unreachable", async () => {
    const service = new SelfActionsTools(makeMockDb(), makeMockConfirmation(), makeMockModuleRef(null));
    const tool = service.tools().find((t) => t.key === "clockIn");
    await expect(tool?.run({}, clockCtx())).resolves.toMatchObject({ kind: "failed" });
  });
});
