import { BadRequestException, NotFoundException } from "@nestjs/common";
import { SubmissionsService } from "./submissions.service";
import { AuditService } from "../../../common/audit/audit.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { Test } from "@nestjs/testing";

const ORG_ID = "org-1";
const USER_ID = "user-1";
const PROJECT_ID = 10;
const FORM_ID = 20;
const SUBMISSION_ID = 30;

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

function makeSubmission(overrides: Record<string, unknown> = {}) {
  return {
    id: SUBMISSION_ID,
    orgId: ORG_ID,
    formId: FORM_ID,
    projectId: PROJECT_ID,
    values: {},
    status: "submitted",
    submittedByName: null,
    submittedById: USER_ID,
    convertedTicketId: null,
    createdAt: new Date(),
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
        where: jest.fn().mockResolvedValue([{ maxNum: 5 }]),
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
    const mockExecute = jest.fn().mockResolvedValue([{ start: 1 }]);

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
        where: jest.fn().mockResolvedValue([{ maxNum: 0 }]),
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
    const mockExecute = jest.fn().mockResolvedValue([{ start: 1 }]);

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
      actions: [{ type: "send_email", config: {} }, { type: "notify_pager", config: {} }],
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
    const mockExecute = jest.fn().mockResolvedValue([{ start: 1 }]);

    (mockDb as Record<string, unknown>)["insert"] = mockInsert;
    (mockDb as Record<string, unknown>)["execute"] = mockExecute;

    (mockDb as { transaction: jest.Mock }).transaction.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = { execute: mockExecute, select: jest.fn(), insert: mockInsert };
        return fn(tx);
      },
    );

    const result = await svc.createSubmission(ORG_ID, USER_ID, PROJECT_ID, FORM_ID, { values: {} });

    expect(result.skippedActionTypes).toEqual(["send_email", "notify_pager"]);
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
    const mockExecute = jest.fn().mockResolvedValue([{ start: 1 }]);

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

  it("allocates the ticket number through the project counter for create_task/create_bug", async () => {
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

    const executeSpy = jest.fn().mockResolvedValue([{ start: 1 }]);
    const mockSelect = jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([{ maxNum: 0 }]),
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

    expect(executeSpy).toHaveBeenCalledTimes(3);
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

describe("SubmissionsService.updateSubmission", () => {
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
    (mockDb.query as { projectForms: { findFirst: jest.Mock } }).projectForms.findFirst.mockResolvedValueOnce(undefined);

    await expect(
      svc.updateSubmission(ORG_ID, USER_ID, PROJECT_ID, FORM_ID, SUBMISSION_ID, { status: "processed" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("throws 404 when submission is not found", async () => {
    (mockDb.query as { projectForms: { findFirst: jest.Mock } }).projectForms.findFirst.mockResolvedValueOnce(makeForm());
    (mockDb.query as { formSubmissions: { findFirst: jest.Mock } }).formSubmissions.findFirst.mockResolvedValueOnce(undefined);

    await expect(
      svc.updateSubmission(ORG_ID, USER_ID, PROJECT_ID, FORM_ID, SUBMISSION_ID, { status: "processed" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("returns 404 when update returns no rows (cross-form guard fires)", async () => {
    (mockDb.query as { projectForms: { findFirst: jest.Mock } }).projectForms.findFirst.mockResolvedValueOnce(makeForm());
    (mockDb.query as { formSubmissions: { findFirst: jest.Mock } }).formSubmissions.findFirst.mockResolvedValueOnce(makeSubmission());

    const mockUpdate = jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([]),
        }),
      }),
    });
    (mockDb as Record<string, unknown>)["update"] = mockUpdate;

    await expect(
      svc.updateSubmission(ORG_ID, USER_ID, PROJECT_ID, FORM_ID, SUBMISSION_ID, { status: "processed" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("returns the updated submission on success", async () => {
    (mockDb.query as { projectForms: { findFirst: jest.Mock } }).projectForms.findFirst.mockResolvedValueOnce(makeForm());
    (mockDb.query as { formSubmissions: { findFirst: jest.Mock } }).formSubmissions.findFirst.mockResolvedValueOnce(makeSubmission());

    const updatedSubmission = makeSubmission({ status: "processed" });
    const mockUpdate = jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([updatedSubmission]),
        }),
      }),
    });
    (mockDb as Record<string, unknown>)["update"] = mockUpdate;

    const result = await svc.updateSubmission(ORG_ID, USER_ID, PROJECT_ID, FORM_ID, SUBMISSION_ID, { status: "processed" });

    expect(result.status).toBe("processed");
    expect(mockAudit.log).toHaveBeenCalledTimes(1);
  });
});

describe("SubmissionsService.submitPublicForm", () => {
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

  it("throws 404 when no form matches publicToken", async () => {
    (mockDb.query as { projectForms: { findFirst: jest.Mock } }).projectForms.findFirst.mockResolvedValueOnce(undefined);

    await expect(
      svc.submitPublicForm("bad-token", { values: {} }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("throws 400 when form found by publicToken is inactive", async () => {
    (mockDb.query as { projectForms: { findFirst: jest.Mock } }).projectForms.findFirst.mockResolvedValueOnce(
      makeForm({ isActive: false, isPublic: true, publicToken: "tok-1" }),
    );

    await expect(
      svc.submitPublicForm("tok-1", { values: {} }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("creates submission with submittedById null for public submissions", async () => {
    const form = makeForm({ isPublic: true, publicToken: "tok-2" });
    (mockDb.query as { projectForms: { findFirst: jest.Mock } }).projectForms.findFirst.mockResolvedValueOnce(form);

    const createdSubmission = {
      id: 10, orgId: ORG_ID, formId: FORM_ID, projectId: PROJECT_ID,
      values: {}, status: "submitted", submittedByName: "Alice",
      submittedById: null, convertedTicketId: null, createdAt: new Date(),
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

    const result = await svc.submitPublicForm("tok-2", { values: {}, submittedByName: "Alice" });

    expect(result.status).toBe("submitted");
    expect(result.submittedByName).toBe("Alice");
    expect(mockAudit.log).toHaveBeenCalledTimes(1);
    const insertCall = mockInsert.mock.calls[0];
    expect(insertCall).toBeDefined();
    const valuesCallArg = (mockInsert.mock.results[0]?.value as { values: jest.Mock }).values.mock.calls[0][0] as Record<string, unknown>;
    expect(valuesCallArg["submittedById"]).toBeNull();
  });

  it("public response does not include orgId or projectId (PII projection)", async () => {
    const form = makeForm({ isPublic: true, publicToken: "tok-3" });
    (mockDb.query as { projectForms: { findFirst: jest.Mock } }).projectForms.findFirst.mockResolvedValueOnce(form);

    const createdSubmission = {
      id: 11, orgId: ORG_ID, formId: FORM_ID, projectId: PROJECT_ID,
      values: {}, status: "submitted", submittedByName: null,
      submittedById: null, convertedTicketId: null, createdAt: new Date(),
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

    const result = await svc.submitPublicForm("tok-3", { values: {} });

    expect("orgId" in result).toBe(false);
    expect("projectId" in result).toBe(false);
    expect("formId" in result).toBe(false);
    expect("submittedById" in result).toBe(false);
    expect("createdTicketIds" in result).toBe(false);
  });
});

describe("SubmissionsService.listSubmissions", () => {
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
    (mockDb.query as { projectForms: { findFirst: jest.Mock } }).projectForms.findFirst.mockResolvedValueOnce(undefined);

    await expect(
      svc.listSubmissions(ORG_ID, PROJECT_ID, FORM_ID, {}),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("returns submissions for the owner org", async () => {
    (mockDb.query as { projectForms: { findFirst: jest.Mock } }).projectForms.findFirst.mockResolvedValueOnce(makeForm());

    const submissions = [makeSubmission()];
    const mockLimit = jest.fn().mockResolvedValue(submissions);
    const mockOrderBy = jest.fn().mockReturnValue({ limit: mockLimit });
    const mockWhere = jest.fn().mockReturnValue({ orderBy: mockOrderBy });
    const mockFrom = jest.fn().mockReturnValue({ where: mockWhere });
    (mockDb as Record<string, unknown>)["select"] = jest.fn().mockReturnValue({ from: mockFrom });

    const result = await svc.listSubmissions(ORG_ID, PROJECT_ID, FORM_ID, {});
    expect(Array.isArray(result)).toBe(true);
    expect(mockLimit).toHaveBeenCalledWith(100);
  });

  it("applies status filter when provided", async () => {
    (mockDb.query as { projectForms: { findFirst: jest.Mock } }).projectForms.findFirst.mockResolvedValueOnce(makeForm());

    const mockLimit = jest.fn().mockResolvedValue([]);
    const mockOrderBy = jest.fn().mockReturnValue({ limit: mockLimit });
    const mockWhere = jest.fn().mockReturnValue({ orderBy: mockOrderBy });
    const mockFrom = jest.fn().mockReturnValue({ where: mockWhere });
    (mockDb as Record<string, unknown>)["select"] = jest.fn().mockReturnValue({ from: mockFrom });

    await svc.listSubmissions(ORG_ID, PROJECT_ID, FORM_ID, { status: "submitted" });
    expect(mockWhere).toHaveBeenCalledTimes(1);
    expect(mockLimit).toHaveBeenCalledWith(100);
  });

  it("applies cursor filter for date-based pagination", async () => {
    (mockDb.query as { projectForms: { findFirst: jest.Mock } }).projectForms.findFirst.mockResolvedValueOnce(makeForm());

    const mockLimit = jest.fn().mockResolvedValue([]);
    const mockOrderBy = jest.fn().mockReturnValue({ limit: mockLimit });
    const mockWhere = jest.fn().mockReturnValue({ orderBy: mockOrderBy });
    const mockFrom = jest.fn().mockReturnValue({ where: mockWhere });
    (mockDb as Record<string, unknown>)["select"] = jest.fn().mockReturnValue({ from: mockFrom });

    await svc.listSubmissions(ORG_ID, PROJECT_ID, FORM_ID, { cursor: "2026-01-01T00:00:00.000Z" });
    expect(mockWhere).toHaveBeenCalledTimes(1);
  });
});
