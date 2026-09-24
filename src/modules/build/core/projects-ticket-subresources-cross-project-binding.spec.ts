import { NotFoundException } from "@nestjs/common";
import { Column, SQL } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import {
  organizationMembers,
  ticketAttachments,
  ticketChecklistItems,
  ticketChecklists,
  ticketComments,
  ticketLabelMappings,
  ticketWatchers,
} from "../../../db/schema";
import { ProjectsTicketSubresourcesService } from "./projects-ticket-subresources.service";
import { ProjectsTicketChecklistsService } from "./projects-ticket-checklists.service";
import { ProjectsTicketCommentsService } from "./projects-ticket-comments.service";

const ORG = "org-1";
const OTHER_ORG = "org-2";
const MEMBERSHIP_ID = 7;
const PROJECT_A = 11;
const PROJECT_B = 22;
const TICKET_A = 900;
const TICKET_B = 901;
const SUBTASK_IN_PROJECT = 910;
const SUBTASK_OUT_OF_PROJECT = 911;
const CHECKLIST_A = 300;
const CHECKLIST_B = 301;
const ITEM_A = 400;
const ITEM_B = 401;
const LABEL_ID = 55;

type Row = Record<string, unknown>;

interface Predicate {
  key: string;
  op: "eq" | "isNull";
  value?: unknown;
}

function columnKey(column: Column): string {
  const table = column.table as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(table)) {
    if (value === column) return key;
  }
  return column.name;
}

function chunkText(chunk: unknown): string {
  const value = (chunk as { value?: unknown } | undefined)?.value;
  return Array.isArray(value) ? value.join("").trim() : "";
}

function collect(node: unknown, out: Predicate[]): Predicate[] {
  if (!(node instanceof SQL)) return out;
  const chunks = node.queryChunks as unknown[];
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (chunk instanceof SQL) {
      collect(chunk, out);
      continue;
    }
    if (!(chunk instanceof Column)) continue;
    const operator = chunkText(chunks[index + 1]);
    if (operator === "=") {
      const param = chunks[index + 2] as { value?: unknown };
      out.push({ key: columnKey(chunk), op: "eq", value: param?.value });
    } else if (operator === "is null") {
      out.push({ key: columnKey(chunk), op: "isNull" });
    }
  }
  return out;
}

function matches(where: unknown, row: Row): boolean {
  const predicates = collect(where, []);
  expect(predicates.length).toBeGreaterThan(0);
  return predicates.every((predicate) =>
    predicate.op === "isNull"
      ? row[predicate.key] === null || row[predicate.key] === undefined
      : row[predicate.key] === predicate.value,
  );
}

interface Store {
  tickets: Row[];
  checklists: Row[];
  items: Row[];
  watchers: Row[];
  labelMappings: Row[];
  attachments: Row[];
}

function makeStore(): Store {
  return {
    tickets: [
      { id: TICKET_A, orgId: ORG, projectId: PROJECT_A, parentTicketId: null, deletedAt: null },
      { id: TICKET_B, orgId: ORG, projectId: PROJECT_B, parentTicketId: null, deletedAt: null },
      { id: SUBTASK_IN_PROJECT, orgId: ORG, projectId: PROJECT_A, parentTicketId: TICKET_A, deletedAt: null, assignees: [], labels: [] },
      { id: SUBTASK_OUT_OF_PROJECT, orgId: ORG, projectId: PROJECT_B, parentTicketId: TICKET_A, deletedAt: null, assignees: [], labels: [] },
    ],
    checklists: [
      { id: CHECKLIST_A, orgId: ORG, ticketId: TICKET_A, title: "checklist-a" },
      { id: CHECKLIST_B, orgId: ORG, ticketId: TICKET_B, title: "checklist-b" },
    ],
    items: [
      { id: ITEM_A, orgId: ORG, checklistId: CHECKLIST_A, text: "item-a", isCompleted: false, assigneeId: null, dueDate: null, order: 0, createdAt: new Date(0) },
      { id: ITEM_B, orgId: ORG, checklistId: CHECKLIST_B, text: "item-b", isCompleted: false, assigneeId: null, dueDate: null, order: 0, createdAt: new Date(0) },
    ],
    watchers: [],
    labelMappings: [],
    attachments: [],
  };
}

interface Fixture {
  db: Db;
  store: Store;
  transaction: jest.Mock;
}

function makeDb(store: Store): Fixture {
  const findFirst = (rows: () => Row[]) =>
    jest.fn(async (args: { where?: unknown }) => rows().find((row) => matches(args.where, row)));

  const selectFrom = (table: unknown): Record<string, unknown> => {
    if (table === organizationMembers) {
      return {
        where: () => ({ limit: async () => [{ id: MEMBERSHIP_ID }] }),
      };
    }
    if (table === ticketComments) {
      const chain: Record<string, unknown> = {
        leftJoin: () => chain,
        where: () => ({
          limit: async () => [
            { id: 9999, orgId: ORG, ticketId: TICKET_A, body: "hi", clientVisible: false, isEdited: false, createdAt: new Date(0), updatedAt: new Date(0), authorId: "user-7", authorDisplayName: null, authorFirstName: null, authorLastName: null, authorImage: null, authorEmail: null },
          ],
        }),
      };
      return chain;
    }
    if (table === ticketChecklists) {
      const chain: Record<string, unknown> = {
        leftJoin: () => chain,
        where: (where: unknown) => ({
          limit: async () =>
            store.checklists
              .filter((row) => matches(where, row))
              .map((row) => ({
                ...row,
                createdAt: new Date(0),
                updatedAt: new Date(0),
                projectId: store.tickets.find((t) => t.id === row.ticketId)?.projectId ?? null,
              })),
        }),
      };
      return chain;
    }
    const chain: Record<string, unknown> = {
      leftJoin: () => chain,
      where: () => ({ limit: async () => [] }),
    };
    return chain;
  };

  const insertBuilder = (table: unknown) => ({
    values: (values: Row) => {
      const target =
        table === ticketWatchers
          ? store.watchers
          : table === ticketLabelMappings
            ? store.labelMappings
            : table === ticketAttachments
              ? store.attachments
              : table === ticketChecklistItems
                ? store.items
                : null;
      const created = { id: 9999, ...values };
      return {
        onConflictDoNothing: () => ({
          returning: async () => {
            if (target) target.push(created);
            return [created];
          },
          then: (resolve: (v: unknown) => unknown) => {
            if (target) target.push(created);
            return Promise.resolve(undefined).then(resolve);
          },
        }),
        returning: async () => {
          if (target) target.push(created);
          return [created];
        },
      };
    },
  });

  const updateBuilder = (table: unknown) => ({
    set: (values: Row) => ({
      where: (where: unknown) => {
        const source =
          table === ticketChecklists ? store.checklists : table === ticketChecklistItems ? store.items : [];
        const hit = source.filter((row) => matches(where, row));
        for (const row of hit) Object.assign(row, values);
        return { returning: async () => hit.map((row) => ({ ...row })) };
      },
    }),
  });

  const deleteBuilder = (table: unknown) => ({
    where: (where: unknown) => {
      const remove = (rows: Row[]) => {
        const hit = rows.filter((row) => matches(where, row));
        for (const row of hit) rows.splice(rows.indexOf(row), 1);
        return hit;
      };
      const hit =
        table === ticketChecklists
          ? remove(store.checklists)
          : table === ticketChecklistItems
            ? remove(store.items)
            : table === ticketWatchers
              ? remove(store.watchers)
              : table === ticketLabelMappings
                ? remove(store.labelMappings)
                : [];
      return {
        returning: async () => hit.map((row) => ({ ...row })),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(undefined).then(resolve),
      };
    },
  });

  const transaction = jest.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
    callback({ update: updateBuilder, insert: insertBuilder, delete: deleteBuilder }),
  );

  const db = {
    query: {
      tickets: {
        findFirst: findFirst(() => store.tickets),
        findMany: jest.fn(async (args: { where?: unknown }) =>
          store.tickets.filter((row) => matches(args.where, row)),
        ),
      },
      ticketChecklists: { findFirst: findFirst(() => store.checklists) },
      ticketChecklistItems: { findFirst: findFirst(() => store.items) },
      ticketWatchers: {
        findMany: jest.fn(async (args: { where?: unknown }) =>
          store.watchers.filter((row) => matches(args.where, row)),
        ),
      },
    },
    select: jest.fn(() => ({ from: selectFrom })),
    insert: insertBuilder,
    update: updateBuilder,
    delete: deleteBuilder,
    transaction,
  } as unknown as Db;

  return { db, store, transaction };
}

function makeU(orgId = ORG): CurrentUserContext {
  return {
    userId: "user-7",
    orgId,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "session-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(MEMBERSHIP_ID, false),
  };
}

function makeSubresources(store: Store) {
  const fixture = makeDb(store);
  const checklists = new ProjectsTicketChecklistsService(fixture.db);
  const comments = new ProjectsTicketCommentsService(
    fixture.db,
    { logTicketActivity: jest.fn(), processCommentMentions: jest.fn() } as never,
    { resolveUserPermissions: jest.fn().mockResolvedValue(new Set(["build:tickets:view"])) } as never,
    { enqueue: jest.fn() } as never,
  );
  const svc = new ProjectsTicketSubresourcesService(
    fixture.db,
    { logTicketActivity: jest.fn() } as never,
    comments,
    checklists,
    {} as never,
    {} as never,
    { scopeFor: jest.fn(), resolveUserPermissions: jest.fn() } as never,
  );
  return { ...fixture, svc, checklists };
}

describe("ticket subresources — a nested lookup binds to the URL project, not just the organisation", () => {
  it("getSubtasks answers 404 for a same-org ticket that belongs to another project", async () => {
    const { svc } = makeSubresources(makeStore());

    await expect(svc.getSubtasks(ORG, PROJECT_A, TICKET_B)).rejects.toThrow(NotFoundException);
  });

  it("getSubtasks returns the subtask that belongs to the URL project (control)", async () => {
    const { svc } = makeSubresources(makeStore());

    const rows = await svc.getSubtasks(ORG, PROJECT_A, TICKET_A);
    expect(rows.map((row) => row.id)).toEqual([SUBTASK_IN_PROJECT]);
  });

  it("getSubtasks omits a child row that names this parent but sits in another project", async () => {
    const { svc } = makeSubresources(makeStore());

    const rows = await svc.getSubtasks(ORG, PROJECT_A, TICKET_A);
    expect(rows.map((row) => row.id)).not.toContain(SUBTASK_OUT_OF_PROJECT);
  });

  it("getWatchers answers 404 for a same-org ticket that belongs to another project", async () => {
    const { svc } = makeSubresources(makeStore());

    await expect(svc.getWatchers(ORG, PROJECT_A, TICKET_B)).rejects.toThrow(NotFoundException);
  });

  it("getWatchers reads the ticket that belongs to the URL project (control)", async () => {
    const store = makeStore();
    store.watchers.push({ id: 1, orgId: ORG, ticketId: TICKET_A, membershipId: MEMBERSHIP_ID, createdAt: new Date(0) });
    const { svc } = makeSubresources(store);

    await expect(svc.getWatchers(ORG, PROJECT_A, TICKET_A)).resolves.toHaveLength(1);
  });

  it("getWatchers does not return another organisation's watcher row for the same ticket id", async () => {
    const store = makeStore();
    store.watchers.push({ id: 1, orgId: OTHER_ORG, ticketId: TICKET_A, membershipId: MEMBERSHIP_ID, createdAt: new Date(0) });
    const { svc } = makeSubresources(store);

    await expect(svc.getWatchers(ORG, PROJECT_A, TICKET_A)).resolves.toEqual([]);
  });

  it("addWatcher does not attach a watcher to a same-org ticket owned by another project", async () => {
    const store = makeStore();
    const { svc } = makeSubresources(store);

    await expect(svc.addWatcher(makeU(), PROJECT_A, TICKET_B, {})).rejects.toThrow(NotFoundException);
    expect(store.watchers).toHaveLength(0);
  });

  it("addWatcher attaches a watcher to the ticket that belongs to the URL project (control)", async () => {
    const store = makeStore();
    const { svc } = makeSubresources(store);

    await expect(svc.addWatcher(makeU(), PROJECT_A, TICKET_A, {})).resolves.toMatchObject({
      membershipId: MEMBERSHIP_ID,
    });
    expect(store.watchers).toHaveLength(1);
  });

  it("removeWatcher does not detach from a same-org ticket owned by another project", async () => {
    const store = makeStore();
    store.watchers.push({ id: 1, orgId: ORG, ticketId: TICKET_B, membershipId: MEMBERSHIP_ID });
    const { svc } = makeSubresources(store);

    await expect(svc.removeWatcher(makeU(), PROJECT_A, TICKET_B)).rejects.toThrow(NotFoundException);
    expect(store.watchers).toHaveLength(1);
  });

  it("removeWatcher detaches from the ticket that belongs to the URL project (control)", async () => {
    const store = makeStore();
    store.watchers.push({ id: 1, orgId: ORG, ticketId: TICKET_A, membershipId: MEMBERSHIP_ID });
    const { svc } = makeSubresources(store);

    await expect(svc.removeWatcher(makeU(), PROJECT_A, TICKET_A)).resolves.toEqual({ success: true });
    expect(store.watchers).toHaveLength(0);
  });

  it("addLabel does not label a same-org ticket owned by another project", async () => {
    const store = makeStore();
    const { svc } = makeSubresources(store);

    await expect(
      svc.addLabel(ORG, "user-7", PROJECT_A, TICKET_B, { labelId: LABEL_ID }),
    ).rejects.toThrow(NotFoundException);
    expect(store.labelMappings).toHaveLength(0);
  });

  it("addLabel labels the ticket that belongs to the URL project (control)", async () => {
    const store = makeStore();
    const { svc } = makeSubresources(store);

    await expect(
      svc.addLabel(ORG, "user-7", PROJECT_A, TICKET_A, { labelId: LABEL_ID }),
    ).resolves.toEqual({ success: true });
    expect(store.labelMappings).toHaveLength(1);
  });

  it("addAttachment does not attach to a same-org ticket owned by another project", async () => {
    const store = makeStore();
    const { svc } = makeSubresources(store);

    await expect(
      svc.addAttachment(makeU(), PROJECT_A, TICKET_B, {
        fileUrl: "https://example.test/f", fileName: "f", fileSize: 1, mimeType: "text/plain",
      } as never),
    ).rejects.toThrow(NotFoundException);
    expect(store.attachments).toHaveLength(0);
  });

  it("addAttachment attaches to the ticket that belongs to the URL project (control)", async () => {
    const store = makeStore();
    const { svc } = makeSubresources(store);

    await expect(
      svc.addAttachment(makeU(), PROJECT_A, TICKET_A, {
        fileUrl: "https://example.test/f", fileName: "f", fileSize: 1, mimeType: "text/plain",
      } as never),
    ).resolves.toMatchObject({ id: 9999 });
    expect(store.attachments).toHaveLength(1);
  });
});

describe("ticket checklists — the whole project/ticket/checklist/item chain is bound", () => {
  it("updateChecklist leaves a same-org checklist on another project's ticket untouched", async () => {
    const store = makeStore();
    const { svc } = makeSubresources(store);

    await expect(
      svc.updateChecklist(ORG, PROJECT_A, TICKET_A, CHECKLIST_B, { title: "hijacked" }),
    ).rejects.toThrow(NotFoundException);
    expect(store.checklists.find((row) => row.id === CHECKLIST_B)?.title).toBe("checklist-b");
  });

  it("updateChecklist renames the checklist that belongs to the URL ticket (control)", async () => {
    const store = makeStore();
    const { svc } = makeSubresources(store);

    await expect(
      svc.updateChecklist(ORG, PROJECT_A, TICKET_A, CHECKLIST_A, { title: "checklist-a-v2" }),
    ).resolves.toMatchObject({ id: CHECKLIST_A, title: "checklist-a-v2" });
  });

  it("updateChecklist answers 404 when the URL ticket is in another project", async () => {
    const store = makeStore();
    const { svc } = makeSubresources(store);

    await expect(
      svc.updateChecklist(ORG, PROJECT_A, TICKET_B, CHECKLIST_B, { title: "hijacked" }),
    ).rejects.toThrow(NotFoundException);
    expect(store.checklists.find((row) => row.id === CHECKLIST_B)?.title).toBe("checklist-b");
  });

  it("deleteChecklist does not delete a same-org checklist on another project's ticket", async () => {
    const store = makeStore();
    const { svc } = makeSubresources(store);

    await expect(svc.deleteChecklist(ORG, PROJECT_A, TICKET_A, CHECKLIST_B)).rejects.toThrow(
      NotFoundException,
    );
    expect(store.checklists.some((row) => row.id === CHECKLIST_B)).toBe(true);
  });

  it("deleteChecklist deletes the checklist that belongs to the URL ticket (control)", async () => {
    const store = makeStore();
    const { svc } = makeSubresources(store);

    await expect(svc.deleteChecklist(ORG, PROJECT_A, TICKET_A, CHECKLIST_A)).resolves.toEqual({
      success: true,
    });
    expect(store.checklists.some((row) => row.id === CHECKLIST_A)).toBe(false);
  });

  it("createChecklistItem does not add an item to a checklist on another project's ticket", async () => {
    const store = makeStore();
    const { svc } = makeSubresources(store);

    await expect(
      svc.createChecklistItem(ORG, PROJECT_A, TICKET_A, CHECKLIST_B, { text: "x", order: 0 }),
    ).rejects.toThrow(NotFoundException);
    expect(store.items.filter((row) => row.checklistId === CHECKLIST_B)).toHaveLength(1);
  });

  it("createChecklistItem adds an item to the checklist on the URL ticket (control)", async () => {
    const store = makeStore();
    const { svc } = makeSubresources(store);

    await expect(
      svc.createChecklistItem(ORG, PROJECT_A, TICKET_A, CHECKLIST_A, { text: "x", order: 0 }),
    ).resolves.toMatchObject({ checklistId: CHECKLIST_A, text: "x" });
    expect(store.items.filter((row) => row.checklistId === CHECKLIST_A)).toHaveLength(2);
  });

  it("updateChecklistItem leaves an item under another project's checklist untouched", async () => {
    const store = makeStore();
    const { svc } = makeSubresources(store);

    await expect(
      svc.updateChecklistItem(ORG, PROJECT_A, TICKET_A, CHECKLIST_B, ITEM_B, { text: "hijacked" }),
    ).rejects.toThrow(NotFoundException);
    expect(store.items.find((row) => row.id === ITEM_B)?.text).toBe("item-b");
  });

  it("updateChecklistItem leaves an item whose own checklist is not the URL checklist untouched", async () => {
    const store = makeStore();
    const { svc } = makeSubresources(store);

    await expect(
      svc.updateChecklistItem(ORG, PROJECT_A, TICKET_A, CHECKLIST_A, ITEM_B, { text: "hijacked" }),
    ).rejects.toThrow(NotFoundException);
    expect(store.items.find((row) => row.id === ITEM_B)?.text).toBe("item-b");
  });

  it("updateChecklistItem edits the item on the URL checklist (control)", async () => {
    const store = makeStore();
    const { svc } = makeSubresources(store);

    await expect(
      svc.updateChecklistItem(ORG, PROJECT_A, TICKET_A, CHECKLIST_A, ITEM_A, { text: "item-a-v2" }),
    ).resolves.toMatchObject({ id: ITEM_A, text: "item-a-v2" });
  });

  it("updateChecklistItem answers 404 for another organisation's item", async () => {
    const store = makeStore();
    const { svc } = makeSubresources(store);

    await expect(
      svc.updateChecklistItem(OTHER_ORG, PROJECT_A, TICKET_A, CHECKLIST_A, ITEM_A, { text: "hijacked" }),
    ).rejects.toThrow(NotFoundException);
    expect(store.items.find((row) => row.id === ITEM_A)?.text).toBe("item-a");
  });

  it("deleteChecklistItem does not delete an item under another project's checklist", async () => {
    const store = makeStore();
    const { svc } = makeSubresources(store);

    await expect(
      svc.deleteChecklistItem(ORG, PROJECT_A, TICKET_A, CHECKLIST_B, ITEM_B),
    ).rejects.toThrow(NotFoundException);
    expect(store.items.some((row) => row.id === ITEM_B)).toBe(true);
  });

  it("deleteChecklistItem does not delete an item whose own checklist is not the URL checklist", async () => {
    const store = makeStore();
    const { svc } = makeSubresources(store);

    await expect(
      svc.deleteChecklistItem(ORG, PROJECT_A, TICKET_A, CHECKLIST_A, ITEM_B),
    ).rejects.toThrow(NotFoundException);
    expect(store.items.some((row) => row.id === ITEM_B)).toBe(true);
  });

  it("deleteChecklistItem deletes the item on the URL checklist (control)", async () => {
    const store = makeStore();
    const { svc } = makeSubresources(store);

    await expect(
      svc.deleteChecklistItem(ORG, PROJECT_A, TICKET_A, CHECKLIST_A, ITEM_A),
    ).resolves.toEqual({ success: true });
    expect(store.items.some((row) => row.id === ITEM_A)).toBe(false);
  });
});

describe("addComment — the URL project is bound when the route carries one", () => {
  it("answers 404 for a same-org ticket that belongs to another project", async () => {
    const { svc, transaction } = makeSubresources(makeStore());

    await expect(
      svc.addComment(makeU(), PROJECT_A, TICKET_B, { content: "hi" } as never),
    ).rejects.toThrow(NotFoundException);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("comments on the ticket that belongs to the URL project (control)", async () => {
    const { svc, transaction } = makeSubresources(makeStore());

    await expect(
      svc.addComment(makeU(), PROJECT_A, TICKET_A, { content: "hi" } as never),
    ).resolves.toMatchObject({ id: 9999, ticketId: TICKET_A });
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("a project-less caller still cannot reach another organisation's ticket", async () => {
    const { svc, transaction } = makeSubresources(makeStore());

    await expect(
      svc.addComment(makeU(OTHER_ORG), null, TICKET_A, { content: "hi" } as never),
    ).rejects.toThrow(NotFoundException);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("a project-less caller still reaches its own organisation's ticket (control)", async () => {
    const { svc, transaction } = makeSubresources(makeStore());

    await expect(
      svc.addComment(makeU(), null, TICKET_B, { content: "hi" } as never),
    ).resolves.toMatchObject({ id: 9999 });
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
