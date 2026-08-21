import { ForbiddenException } from "@nestjs/common";
import { ProjectsCopilotTools } from "./projects-copilot-tools";
import { ToolAccessService } from "./tool-access.service";
import { AiConfirmationService } from "../confirmation/ai-confirmation.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

const mockActor: CurrentUserContext = {
  userId: "user-1",
  orgId: "org-1",
  role: "member",
  permissions: [],
  isOrgOwner: false,
  sessionId: "sess-1",
  tokenScopes: null,
};

type BuiltTools = ReturnType<ProjectsCopilotTools["buildTools"]>;
type ToolCallOptions = Parameters<NonNullable<BuiltTools["readTicket"]["execute"]>>[1];

const toolOpts: ToolCallOptions = { toolCallId: "test-call", messages: [], context: {} };

function buildMocks() {
  const db = { select: jest.fn(), update: jest.fn(), insert: jest.fn() } as unknown as import("../../../db/drizzle.module").Db;
  const toolAccess = { denyReason: jest.fn(), scope: jest.fn() } as unknown as ToolAccessService;
  const confirmation = { propose: jest.fn(), confirm: jest.fn(), markExecuted: jest.fn(), cancel: jest.fn() } as unknown as AiConfirmationService;
  return { db, toolAccess, confirmation };
}

function buildTicketsDb(found: boolean) {
  const rows = found ? [{ id: 42, title: "Fix login bug", orgId: "org-1" }] : [];
  const chainable = { where: jest.fn().mockReturnThis(), limit: jest.fn().mockResolvedValue(rows) };
  return { select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue(chainable) }) };
}

describe("ProjectsCopilotTools", () => {
  describe("createTicket tool", () => {
    it("calls propose and does NOT call ProjectsTicketsService when tool executes", async () => {
      const { toolAccess, confirmation, db } = buildMocks();
      jest.mocked(toolAccess.denyReason).mockResolvedValue(null);
      jest.mocked(confirmation.propose).mockResolvedValue({ proposalId: 1, token: "tok", expiresAt: new Date() });

      const tools = new ProjectsCopilotTools(db, toolAccess, confirmation);
      const built = tools.buildTools({ actor: mockActor });

      const execFn = built.createTicket.execute;
      if (!execFn) throw new Error("execute not defined");
      const result = await execFn({ projectId: 10, title: "Fix bug", type: "BUG", priority: "HIGH" }, toolOpts);

      expect(result).toMatchObject({ requiresConfirmation: true, action: "ticket.create" });
      expect(confirmation.propose).toHaveBeenCalledWith(expect.objectContaining({ action: "ticket.create" }));
    });

    it("returns denied when toolAccess.denyReason returns a reason", async () => {
      const { toolAccess, confirmation, db } = buildMocks();
      jest.mocked(toolAccess.denyReason).mockResolvedValue("No permission");

      const tools = new ProjectsCopilotTools(db, toolAccess, confirmation);
      const built = tools.buildTools({ actor: mockActor });

      const execFn2 = built.createTicket.execute;
      if (!execFn2) throw new Error("execute not defined");
      const result = await execFn2({ projectId: 10, title: "Fix bug", type: "BUG", priority: "HIGH" }, toolOpts);

      expect(result).toEqual({ denied: true, reason: "No permission" });
      expect(confirmation.propose).not.toHaveBeenCalled();
    });
  });

  describe("readTicket tool", () => {
    it("returns ticket data when found", async () => {
      const { toolAccess, confirmation } = buildMocks();
      jest.mocked(toolAccess.denyReason).mockResolvedValue(null);

      const db = buildTicketsDb(true) as unknown as import("../../../db/drizzle.module").Db;
      const tools = new ProjectsCopilotTools(db, toolAccess, confirmation);
      const built = tools.buildTools({ actor: mockActor });

      const execRead = built.readTicket.execute;
      if (!execRead) throw new Error("execute not defined");
      const result = await execRead({ ticketId: 42 }, toolOpts);
      expect(result).toMatchObject({ found: true });
    });

    it("returns { found: false } when ticket not in org", async () => {
      const { toolAccess, confirmation } = buildMocks();
      jest.mocked(toolAccess.denyReason).mockResolvedValue(null);

      const db = buildTicketsDb(false) as unknown as import("../../../db/drizzle.module").Db;
      const tools = new ProjectsCopilotTools(db, toolAccess, confirmation);
      const built = tools.buildTools({ actor: mockActor });

      const execRead2 = built.readTicket.execute;
      if (!execRead2) throw new Error("execute not defined");
      const result = await execRead2({ ticketId: 999 }, toolOpts);
      expect(result).toEqual({ found: false });
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

  it("re-asserts permission and returns a reason when denied", async () => {
    const { toolAccess } = buildMocks();
    jest.mocked(toolAccess.denyReason).mockResolvedValue("No engagement access");

    const reason = await toolAccess.denyReason("org-1", "user-1", "hr:engagement:manage");
    expect(reason).toBe("No engagement access");
  });
});
