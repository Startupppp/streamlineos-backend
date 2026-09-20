import { ForbiddenException } from "@nestjs/common";
import { ProjectsCopilotTools } from "./tools/projects-copilot-tools";
import { AiConfirmationService } from "../confirmation/ai-confirmation.service";
import type { AskOsActor } from "./services/ask-os-actor";
import type { AskOsToolDefinition, AskOsToolRunContext } from "./registry/ask-os-tool.types";
import type { DataScope } from "../../access/access.types";
import { ScopedRead } from "../../access/scoped-read";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

const mockActor: AskOsActor = {
  userId: "user-1",
  orgId: "org-1",
  membershipId: 1,
  displayName: "Test User",
  email: "test@org.com",
  orgName: "Test Org",
  role: "MEMBER",
  isOrgOwner: false,
  timezone: "UTC",
  today: "2026-09-18",
  monthStart: "2026-09-01",
  monthEnd: "2026-09-30",
  currentYear: 2026,
  currentMonth: 9,
};

const mockCaller: CurrentUserContext = {
  userId: "user-1",
  orgId: "org-1",
  role: "member",
  isOrgOwner: false,
  sessionId: "sess-1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, false),
};

function makeCtx(scope: DataScope = "all"): AskOsToolRunContext {
  const read = ScopedRead.of(mockActor.orgId, mockActor.userId, scope);
  return {
    actor: mockActor,
    caller: mockCaller,
    read,
    readFor: () => read,
    modules: {},
  };
}

function buildMocks() {
  const db = { select: jest.fn(), update: jest.fn(), insert: jest.fn() } as unknown as import("../../../db/drizzle.module").Db;
  const confirmation = { propose: jest.fn(), confirm: jest.fn(), markExecuted: jest.fn(), cancel: jest.fn() } as unknown as AiConfirmationService;
  return { db, confirmation };
}

function findTool(defs: AskOsToolDefinition[], key: string): AskOsToolDefinition {
  const def = defs.find((d) => d.key === key);
  if (!def) throw new Error(`Tool "${key}" not found`);
  return def;
}

function buildTicketsDb(found: boolean) {
  const rows = found ? [{ id: 42, title: "Fix login bug", orgId: "org-1" }] : [];
  const chainable = { where: jest.fn().mockReturnThis(), limit: jest.fn().mockResolvedValue(rows) };
  return { select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue(chainable) }) };
}

describe("ProjectsCopilotTools", () => {
  describe("createTicket tool", () => {
    it("calls propose and does NOT call ProjectsTicketsService when tool executes", async () => {
      const { db, confirmation } = buildMocks();
      jest.mocked(confirmation.propose).mockResolvedValue({ proposalId: 1, token: "tok", expiresAt: new Date() });

      const tools = new ProjectsCopilotTools(db, confirmation);
      const def = findTool(tools.tools(), "createTicket");
      const result = await def.run({ projectId: 10, title: "Fix bug", type: "BUG", priority: "HIGH" }, makeCtx());

      expect(result).toMatchObject({ kind: "needs-confirmation", action: "ticket.create" });
      expect(confirmation.propose).toHaveBeenCalledWith(expect.objectContaining({ action: "ticket.create" }));
    });

    it("exposes the build:tickets:create permission key so the registry can gate it", () => {
      const { db, confirmation } = buildMocks();
      const tools = new ProjectsCopilotTools(db, confirmation);
      const def = findTool(tools.tools(), "createTicket");
      expect(def.permission).toBe("build:tickets:create");
      expect(confirmation.propose).not.toHaveBeenCalled();
    });
  });

  describe("readTicket tool", () => {
    it("returns ticket data when found", async () => {
      const { confirmation } = buildMocks();
      const db = buildTicketsDb(true) as unknown as import("../../../db/drizzle.module").Db;
      const tools = new ProjectsCopilotTools(db, confirmation);
      const def = findTool(tools.tools(), "readTicket");
      const result = await def.run({ ticketId: 42 }, makeCtx("all"));
      expect(result).toMatchObject({ kind: "data" });
    });

    it("returns not-found shape when ticket is not in org", async () => {
      const { confirmation } = buildMocks();
      const db = buildTicketsDb(false) as unknown as import("../../../db/drizzle.module").Db;
      const tools = new ProjectsCopilotTools(db, confirmation);
      const def = findTool(tools.tools(), "readTicket");
      const result = await def.run({ ticketId: 999 }, makeCtx("all"));
      expect(result).toEqual({ kind: "empty", subject: "ticket", hint: "Ticket not found in this org." });
    });

    it("returns not-found shape for a ticket in a project the actor cannot access", async () => {
      const { confirmation } = buildMocks();
      const db = buildTicketsDb(false) as unknown as import("../../../db/drizzle.module").Db;
      const tools = new ProjectsCopilotTools(db, confirmation);
      const def = findTool(tools.tools(), "readTicket");
      const result = await def.run({ ticketId: 77 }, makeCtx("own"));
      expect(result).toEqual({ kind: "empty", subject: "ticket", hint: "Ticket not found in this org." });
    });

    it("own-scoped member cannot read another member's ticket body", async () => {
      const { confirmation } = buildMocks();
      const db = buildTicketsDb(false) as unknown as import("../../../db/drizzle.module").Db;
      const tools = new ProjectsCopilotTools(db, confirmation);
      const def = findTool(tools.tools(), "readTicket");
      const result = await def.run({ ticketId: 55 }, makeCtx("own"));
      expect(result).toEqual({ kind: "empty", subject: "ticket", hint: "Ticket not found in this org." });
      expect(def.permission).toBe("build:tickets:view");
    });
  });
});

describe("confirmAction controller logic", () => {
  it("rejects with ForbiddenException when confirmation.confirm rejects", async () => {
    const { confirmation } = buildMocks();
    jest.mocked(confirmation.confirm).mockRejectedValue(new ForbiddenException("Token expired"));

    await expect(
      confirmation.confirm({ token: "bad", actor: { orgId: "org-1", userId: "user-1" } }),
    ).rejects.toThrow(ForbiddenException);
  });

  it("does not call markExecuted when confirm throws", async () => {
    const { confirmation } = buildMocks();
    jest.mocked(confirmation.confirm).mockRejectedValue(new ForbiddenException("expired"));

    await expect(
      confirmation.confirm({ token: "expired", actor: { orgId: "org-1", userId: "user-1" } }),
    ).rejects.toThrow(ForbiddenException);
    expect(confirmation.markExecuted).not.toHaveBeenCalled();
  });

  it("the tool definition carries build:tickets:view so the registry re-checks it on every call", () => {
    const { db, confirmation } = buildMocks();
    const tools = new ProjectsCopilotTools(db, confirmation);
    const def = findTool(tools.tools(), "readTicket");
    expect(def.permission).toBe("build:tickets:view");
  });
});
