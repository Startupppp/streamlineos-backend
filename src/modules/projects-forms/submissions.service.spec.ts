import { BadRequestException, NotFoundException } from "@nestjs/common";
import { SubmissionsService } from "./submissions.service";
import type { AuditService } from "../../common/audit/audit.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { Test } from "@nestjs/testing";

const ORG_ID = "org-1";
const USER_ID = "user-1";
const PROJECT_ID = 10;
const FORM_ID = 20;

function makeForm(overrides: Record<string, unknown> = {}) {
  return {
    id: FORM_ID,
    orgId: ORG_ID,
    projectId: PROJECT_ID,
    name: "Bug Report Form",
    isActive: true,
    actions: [],
    ...overrides,
  };
}

const mockAudit = { log: jest.fn() } as unknown as AuditService;

describe("SubmissionsService.createSubmission", () => {
  let svc: SubmissionsService;
  let mockDb: Record<string, unknown>;

  beforeEach(async () => {
    jest.resetAllMocks();

    mockDb = {
      query: {
        projectForms: { findFirst: jest.fn() },
        formSubmissions: { findFirst: jest.fn() },
      },
      transaction: jest.fn(),
    };

    const module = await Test.createTestingModule({
      providers: [
        SubmissionsService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AuditService, useValue: mockAudit },
      ],
    }).compile();
    svc = module.get(SubmissionsService);
  });

  it("throws 404 when form is not found", async () => {
    (mockDb["query"] as Record<string, unknown>);
    (mockDb.query as { projectForms: { findFirst: jest.Mock } }).projectForms.findFirst.mockResolvedValueOnce(undefined);

    await expect(
      svc.createSubmission(ORG_ID, USER_ID, PROJECT_ID, FORM_ID, { values: {} }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("throws 400 when form is inactive", async () => {
    (mockDb.query as { projectForms: { findFirst: jest.Mock } }).projectForms.findFirst.mockResolvedValueOnce(
      makeForm({ isActive: false }),
    );

    await expect(
      svc.createSubmission(ORG_ID, USER_ID, PROJECT_ID, FORM_ID, { values: {} }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("executes create_task action: inserts a ticket and sets convertedTicketId + status=processed", async () => {
    const form = makeForm({
      actions: [{ type: "create_task", config: { titleField: "summary" } }],
    });
    (mockDb.query as { projectForms: { findFirst: jest.Mock } }).projectForms.findFirst.mockResolvedValueOnce(form);

    const createdTicket = { id: 99 };
    const createdSubmission = {
      id: 1,
      orgId: ORG_ID,
      formId: FORM_ID,
      projectId: PROJECT_ID,
      values: { summary: "Fix login" },
      status: "processed",
      convertedTicketId: 99,
    };

    const mockSelect = jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([{ maxNum: 5 }]),
        }),
      }),
    });
    const mockInsertTicket = jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([createdTicket]),
      }),
    });
    const mockInsertSubmission = jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([createdSubmission]),
      }),
    });
    const mockExecute = jest.fn().mockResolvedValue(undefined);

    let insertCallCount = 0;
    const mockInsert = jest.fn().mockImplementation(() => {
      insertCallCount++;
      if (insertCallCount === 1) return mockInsertTicket();
      return mockInsertSubmission();
    });

    (mockDb as Record<string, unknown>)["select"] = mockSelect;
    (mockDb as Record<string, unknown>)["insert"] = mockInsert;
    (mockDb as Record<string, unknown>)["execute"] = mockExecute;

    (mockDb as { transaction: jest.Mock }).transaction.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          execute: mockExecute,
          select: mockSelect,
          insert: mockInsert,
        };
        return fn(tx);
      },
    );

    const result = await svc.createSubmission(ORG_ID, USER_ID, PROJECT_ID, FORM_ID, {
      values: { summary: "Fix login" },
    });

    expect(result.status).toBe("processed");
    expect(result.convertedTicketId).toBe(99);
    expect(result.executedActionTypes).toContain("create_task");
    expect(result.skippedActionTypes).toHaveLength(0);
    expect(result.createdTicketIds).toContain(99);
    expect(mockAudit.log).toHaveBeenCalledTimes(1);
  });

  it("executes create_bug action: creates a BUG-type ticket", async () => {
    const form = makeForm({
      actions: [{ type: "create_bug", config: {} }],
    });
    (mockDb.query as { projectForms: { findFirst: jest.Mock } }).projectForms.findFirst.mockResolvedValueOnce(form);

    const createdTicket = { id: 55 };
    const createdSubmission = {
      id: 2,
      orgId: ORG_ID,
      formId: FORM_ID,
      projectId: PROJECT_ID,
      values: {},
      status: "processed",
      convertedTicketId: 55,
    };

    const mockSelect = jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([{ maxNum: 0 }]),
        }),
      }),
    });
    let insertCallCount = 0;
    const mockInsert = jest.fn().mockImplementation(() => {
      insertCallCount++;
      if (insertCallCount === 1) {
        return {
          values: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([createdTicket]),
          }),
        };
      }
      return {
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([createdSubmission]),
        }),
      };
    });
    const mockExecute = jest.fn().mockResolvedValue(undefined);

    (mockDb as Record<string, unknown>)["select"] = mockSelect;
    (mockDb as Record<string, unknown>)["insert"] = mockInsert;
    (mockDb as Record<string, unknown>)["execute"] = mockExecute;

    (mockDb as { transaction: jest.Mock }).transaction.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = { execute: mockExecute, select: mockSelect, insert: mockInsert };
        return fn(tx);
      },
    );

    const result = await svc.createSubmission(ORG_ID, USER_ID, PROJECT_ID, FORM_ID, { values: {} });

    expect(result.executedActionTypes).toContain("create_bug");
    expect(result.status).toBe("processed");
    expect(result.convertedTicketId).toBe(55);
  });

  it("skips actions of unknown types: collects them in skippedActionTypes", async () => {
    const form = makeForm({
      actions: [{ type: "send_email", config: {} }, { type: "notify_slack", config: {} }],
    });
    (mockDb.query as { projectForms: { findFirst: jest.Mock } }).projectForms.findFirst.mockResolvedValueOnce(form);

    const createdSubmission = {
      id: 3,
      orgId: ORG_ID,
      formId: FORM_ID,
      projectId: PROJECT_ID,
      values: {},
      status: "submitted",
      convertedTicketId: null,
    };
    const mockInsert = jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([createdSubmission]),
      }),
    });
    const mockExecute = jest.fn().mockResolvedValue(undefined);

    (mockDb as Record<string, unknown>)["insert"] = mockInsert;
    (mockDb as Record<string, unknown>)["execute"] = mockExecute;

    (mockDb as { transaction: jest.Mock }).transaction.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = { execute: mockExecute, select: jest.fn(), insert: mockInsert };
        return fn(tx);
      },
    );

    const result = await svc.createSubmission(ORG_ID, USER_ID, PROJECT_ID, FORM_ID, { values: {} });

    expect(result.skippedActionTypes).toEqual(["send_email", "notify_slack"]);
    expect(result.executedActionTypes).toHaveLength(0);
    expect(result.status).toBe("submitted");
    expect(result.convertedTicketId).toBeNull();
  });

  it("submission with no create actions stays status=submitted", async () => {
    const form = makeForm({ actions: [] });
    (mockDb.query as { projectForms: { findFirst: jest.Mock } }).projectForms.findFirst.mockResolvedValueOnce(form);

    const createdSubmission = {
      id: 4,
      orgId: ORG_ID,
      formId: FORM_ID,
      projectId: PROJECT_ID,
      values: {},
      status: "submitted",
      convertedTicketId: null,
    };
    const mockInsert = jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([createdSubmission]),
      }),
    });
    const mockExecute = jest.fn().mockResolvedValue(undefined);

    (mockDb as Record<string, unknown>)["insert"] = mockInsert;
    (mockDb as Record<string, unknown>)["execute"] = mockExecute;

    (mockDb as { transaction: jest.Mock }).transaction.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = { execute: mockExecute, select: jest.fn(), insert: mockInsert };
        return fn(tx);
      },
    );

    const result = await svc.createSubmission(ORG_ID, USER_ID, PROJECT_ID, FORM_ID, { values: {} });

    expect(result.status).toBe("submitted");
    expect(result.createdTicketIds).toHaveLength(0);
    expect(result.convertedTicketId).toBeNull();
  });

  it("uses advisory lock when form has create_task or create_bug action", async () => {
    const form = makeForm({ actions: [{ type: "create_task", config: {} }] });
    (mockDb.query as { projectForms: { findFirst: jest.Mock } }).projectForms.findFirst.mockResolvedValueOnce(form);

    const createdTicket = { id: 77 };
    const createdSubmission = {
      id: 5,
      orgId: ORG_ID,
      formId: FORM_ID,
      projectId: PROJECT_ID,
      values: {},
      status: "processed",
      convertedTicketId: 77,
    };

    const executeSpy = jest.fn().mockResolvedValue(undefined);
    const mockSelect = jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([{ maxNum: 0 }]),
        }),
      }),
    });
    let insertCallCount = 0;
    const mockInsert = jest.fn().mockImplementation(() => {
      insertCallCount++;
      if (insertCallCount === 1) {
        return { values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([createdTicket]) }) };
      }
      return { values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([createdSubmission]) }) };
    });

    (mockDb as Record<string, unknown>)["select"] = mockSelect;
    (mockDb as Record<string, unknown>)["insert"] = mockInsert;
    (mockDb as Record<string, unknown>)["execute"] = executeSpy;

    (mockDb as { transaction: jest.Mock }).transaction.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = { execute: executeSpy, select: mockSelect, insert: mockInsert };
        return fn(tx);
      },
    );

    await svc.createSubmission(ORG_ID, USER_ID, PROJECT_ID, FORM_ID, { values: {} });

    expect(executeSpy).toHaveBeenCalledTimes(1);
  });

  it("does NOT acquire advisory lock when form has no create_task/create_bug actions", async () => {
    const form = makeForm({ actions: [{ type: "notify", config: {} }] });
    (mockDb.query as { projectForms: { findFirst: jest.Mock } }).projectForms.findFirst.mockResolvedValueOnce(form);

    const createdSubmission = {
      id: 6, orgId: ORG_ID, formId: FORM_ID, projectId: PROJECT_ID,
      values: {}, status: "submitted", convertedTicketId: null,
    };
    const executeSpy = jest.fn().mockResolvedValue(undefined);
    const mockInsert = jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([createdSubmission]) }),
    });

    (mockDb as Record<string, unknown>)["insert"] = mockInsert;
    (mockDb as Record<string, unknown>)["execute"] = executeSpy;

    (mockDb as { transaction: jest.Mock }).transaction.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = { execute: executeSpy, select: jest.fn(), insert: mockInsert };
        return fn(tx);
      },
    );

    await svc.createSubmission(ORG_ID, USER_ID, PROJECT_ID, FORM_ID, { values: {} });

    expect(executeSpy).not.toHaveBeenCalled();
  });
});
