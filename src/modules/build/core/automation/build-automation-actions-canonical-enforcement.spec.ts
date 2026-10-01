import { BadRequestException } from "@nestjs/common";
import { BuildAutomationActionExecutor } from "./build-automation-actions.service";
import type { Db } from "../../../../db/drizzle.module";
import { assertTransitionAllowed } from "../tickets/projects-tickets-workflow-utils";
import { OutboxWriter } from "../../../../common/outbox/outbox-writer";

jest.mock("../tickets/projects-tickets-workflow-utils", () => ({
  assertTransitionAllowed: jest.fn(),
}));

jest.mock("../../../../common/outbox/outbox-writer", () => ({
  OutboxWriter: { emit: jest.fn() },
}));

const ORG = "org-enforcement";
const PROJECT = 5;
const TICKET = 42;
const RULE = 1;
const AUTHOR = "user-auto";

function makeDb(opts: {
  statusExists?: boolean;
  currentStatus?: string;
  label?: { id: number } | null;
  member?: { id: number } | null;
} = {}) {
  const {
    statusExists = true,
    currentStatus = "TODO",
    label = { id: 77 },
    member = null,
  } = opts;

  const returning = jest.fn().mockResolvedValue([{ version: 2 }]);
  const txWhere = jest.fn().mockReturnValue({ returning });
  const txSet = jest.fn().mockReturnValue({ where: txWhere });
  const txUpdate = jest.fn().mockReturnValue({ set: txSet });
  const txInsert = jest.fn().mockReturnValue({
    values: jest.fn().mockResolvedValue([{ id: 999 }]),
    onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
  });
  const txSelectWhere = jest.fn().mockResolvedValue([]);
  const txSelectFrom = jest.fn().mockReturnValue({ where: txSelectWhere });
  const txSelect = jest.fn().mockReturnValue({ from: txSelectFrom });

  const transaction = jest.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
    cb({ update: txUpdate, insert: txInsert, select: txSelect, execute: jest.fn().mockResolvedValue([]) }),
  );

  const selectWhere = jest.fn().mockResolvedValue([]);
  const selectFrom = jest.fn().mockReturnValue({ where: selectWhere });
  const select = jest.fn().mockReturnValue({ from: selectFrom });

  const topInsertValues = jest.fn().mockReturnValue({
    onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
  });
  const topInsert = jest.fn().mockReturnValue({ values: topInsertValues });
  const topWhere = jest.fn().mockResolvedValue([]);
  const topSet = jest.fn().mockReturnValue({ where: topWhere });
  const topUpdate = jest.fn().mockReturnValue({ set: topSet });

  const db = {
    query: {
      projectStatuses: {
        findFirst: jest.fn().mockResolvedValue(statusExists ? { id: 7 } : undefined),
      },
      tickets: {
        findFirst: jest.fn().mockResolvedValue(
          currentStatus !== null ? { id: TICKET, status: currentStatus, version: 1 } : undefined,
        ),
      },
      ticketLabels: {
        findFirst: jest.fn().mockResolvedValue(label),
      },
      organizationMembers: {
        findFirst: jest.fn().mockResolvedValue(member),
      },
    },
    select,
    insert: topInsert,
    update: topUpdate,
    transaction,
  } as unknown as Db;

  return { db, transaction, txUpdate, txWhere, txInsert };
}

function makeActivity() {
  return { logTicketActivity: jest.fn().mockResolvedValue(undefined) };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(assertTransitionAllowed).mockResolvedValue(undefined);
  jest.mocked(OutboxWriter.emit).mockResolvedValue(undefined);
});

describe("BuildAutomationActionExecutor — set_status enforcement", () => {
  it("calls assertTransitionAllowed inside the transaction before committing", async () => {
    const { db } = makeDb({ currentStatus: "TODO" });
    const activity = makeActivity();
    const executor = new BuildAutomationActionExecutor(db, activity as never);

    await executor.execute(ORG, PROJECT, TICKET, RULE, { type: "set_status", value: "DONE" }, AUTHOR);

    expect(assertTransitionAllowed).toHaveBeenCalledWith(
      expect.anything(),
      ORG,
      PROJECT,
      "TODO",
      "DONE",
      expect.objectContaining({ ticketId: TICKET }),
    );
  });

  it("aborts when assertTransitionAllowed rejects with BadRequestException", async () => {
    const { db, transaction } = makeDb({ currentStatus: "TODO" });
    const activity = makeActivity();
    const executor = new BuildAutomationActionExecutor(db, activity as never);

    jest.mocked(assertTransitionAllowed).mockRejectedValue(
      new BadRequestException("Transition blocked"),
    );

    await expect(
      executor.execute(ORG, PROJECT, TICKET, RULE, { type: "set_status", value: "DONE" }, AUTHOR),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(activity.logTicketActivity).not.toHaveBeenCalled();
  });

  it("emits a build.ticket.status_changed outbox event inside the transaction", async () => {
    const { db } = makeDb({ currentStatus: "TODO" });
    const activity = makeActivity();
    const executor = new BuildAutomationActionExecutor(db, activity as never);

    await executor.execute(ORG, PROJECT, TICKET, RULE, { type: "set_status", value: "DONE" }, AUTHOR);

    expect(OutboxWriter.emit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: "build.ticket.status_changed",
        organizationId: ORG,
        payload: expect.objectContaining({
          ticketId: TICKET,
          projectId: PROJECT,
          previousStatus: "TODO",
          newStatus: "DONE",
        }),
      }),
    );
  });

  it("logs status_changed activity after the transaction commits", async () => {
    const { db } = makeDb({ currentStatus: "TODO" });
    const activity = makeActivity();
    const executor = new BuildAutomationActionExecutor(db, activity as never);

    await executor.execute(ORG, PROJECT, TICKET, RULE, { type: "set_status", value: "DONE" }, AUTHOR);

    expect(activity.logTicketActivity).toHaveBeenCalledWith(
      ORG,
      TICKET,
      AUTHOR,
      "status_changed",
      "TODO",
      "DONE",
    );
  });

  it("does not emit the outbox event when the ticket is not found (early exit)", async () => {
    const { db } = makeDb({ statusExists: false });
    const activity = makeActivity();
    const executor = new BuildAutomationActionExecutor(db, activity as never);

    await executor.execute(ORG, PROJECT, TICKET, RULE, { type: "set_status", value: "DONE" }, AUTHOR);

    expect(OutboxWriter.emit).not.toHaveBeenCalled();
    expect(activity.logTicketActivity).not.toHaveBeenCalled();
  });
});

describe("BuildAutomationActionExecutor — activity logging for non-status actions", () => {
  it("logs assignee_changed after set_assignee", async () => {
    const { db } = makeDb({ member: { id: 3 } });
    const activity = makeActivity();
    const executor = new BuildAutomationActionExecutor(db, activity as never);

    await executor.execute(ORG, PROJECT, TICKET, RULE, { type: "set_assignee", value: "user-x" }, AUTHOR);

    expect(activity.logTicketActivity).toHaveBeenCalledWith(ORG, TICKET, AUTHOR, "assignee_changed");
  });

  it("logs priority_changed after set_priority", async () => {
    const { db } = makeDb();
    const activity = makeActivity();
    const executor = new BuildAutomationActionExecutor(db, activity as never);

    await executor.execute(ORG, PROJECT, TICKET, RULE, { type: "set_priority", value: "HIGH" }, AUTHOR);

    expect(activity.logTicketActivity).toHaveBeenCalledWith(ORG, TICKET, AUTHOR, "priority_changed");
  });

  it("logs label_changed after add_label when the label exists", async () => {
    const { db } = makeDb({ label: { id: 77 } });
    const activity = makeActivity();
    const executor = new BuildAutomationActionExecutor(db, activity as never);

    await executor.execute(ORG, PROJECT, TICKET, RULE, { type: "add_label", value: "77" }, AUTHOR);

    expect(activity.logTicketActivity).toHaveBeenCalledWith(ORG, TICKET, AUTHOR, "label_changed");
  });

  it("does not log when the label is not found", async () => {
    const { db } = makeDb({ label: null });
    const activity = makeActivity();
    const executor = new BuildAutomationActionExecutor(db, activity as never);

    await executor.execute(ORG, PROJECT, TICKET, RULE, { type: "add_label", value: "99" }, AUTHOR);

    expect(activity.logTicketActivity).not.toHaveBeenCalled();
  });

  it("logs comment_added after add_comment when authorId is present", async () => {
    const { db } = makeDb();
    const activity = makeActivity();
    const executor = new BuildAutomationActionExecutor(db, activity as never);

    await executor.execute(ORG, PROJECT, TICKET, RULE, { type: "add_comment", value: "hello" }, AUTHOR);

    expect(activity.logTicketActivity).toHaveBeenCalledWith(ORG, TICKET, AUTHOR, "comment_added");
  });

  it("does not log comment_added when authorId is null", async () => {
    const { db } = makeDb();
    const activity = makeActivity();
    const executor = new BuildAutomationActionExecutor(db, activity as never);

    await executor.execute(ORG, PROJECT, TICKET, RULE, { type: "add_comment", value: "hello" }, null);

    expect(activity.logTicketActivity).not.toHaveBeenCalled();
  });
});
