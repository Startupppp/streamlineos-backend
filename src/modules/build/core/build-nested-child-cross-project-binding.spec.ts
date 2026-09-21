import { ConflictException, NotFoundException } from "@nestjs/common";
import { Column, SQL } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import type { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { projectStatuses, projectWebhooks, tickets } from "../../../db/schema";
import { customFieldDefinitions } from "../../../db/schema/custom-field-engine";
import { ProjectsCustomStatesService } from "./projects-custom-states.service";
import { ProjectsCustomFieldsService } from "./projects-custom-fields.service";
import { ProjectsWebhooksService } from "./projects-webhooks.service";
import type { UpdateCustomFieldInput } from "./dto/custom-fields.schemas";
import type { UpdateCustomStateInput } from "./dto/projects.schemas";

const ORG = "org-1";
const OTHER_ORG = "org-2";
const MEMBERSHIP_ID = 7;
const PROJECT_A = 11;
const PROJECT_B = 22;
const ABSENT_PROJECT = 9999;

const STATE_A_TODO = 501;
const STATE_A_DOING = 502;
const STATE_A_DONE = 503;
const STATE_B_BACKLOG = 511;
const STATE_B_SHIPPED = 512;

const FIELD_A = 601;
const FIELD_B = 611;

const HOOK_A = 701;
const HOOK_B = 711;

const TICKET_A = 901;
const TICKET_B = 902;

type Row = Record<string, unknown>;

interface Predicate {
  key: string;
  op: "eq" | "ne" | "isNull";
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
    const param = chunks[index + 2] as { value?: unknown };
    if (operator === "=") {
      out.push({ key: columnKey(chunk), op: "eq", value: param?.value });
    } else if (operator === "<>") {
      out.push({ key: columnKey(chunk), op: "ne", value: param?.value });
    } else if (operator === "is null") {
      out.push({ key: columnKey(chunk), op: "isNull" });
    }
  }
  return out;
}

function matches(where: unknown, row: Row): boolean {
  const predicates = collect(where, []);
  expect(predicates.length).toBeGreaterThan(0);
  return predicates.every((predicate) => {
    if (predicate.op === "isNull")
      return row[predicate.key] === null || row[predicate.key] === undefined;
    if (predicate.op === "ne") return row[predicate.key] !== predicate.value;
    return row[predicate.key] === predicate.value;
  });
}

function assign(row: Row, values: Row): void {
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) row[key] = value;
  }
}

interface Store {
  projects: Row[];
  statuses: Row[];
  tickets: Row[];
  fields: Row[];
  webhooks: Row[];
}

function makeStore(): Store {
  return {
    projects: [
      { id: PROJECT_A, orgId: ORG, managerMembershipId: 999, deletedAt: null },
      { id: PROJECT_B, orgId: ORG, managerMembershipId: 999, deletedAt: null },
    ],
    statuses: [
      { id: STATE_A_TODO, orgId: ORG, projectId: PROJECT_A, name: "Todo", order: 0, color: "#111111", type: "unstarted", wipLimit: null },
      { id: STATE_A_DOING, orgId: ORG, projectId: PROJECT_A, name: "Doing", order: 1, color: "#222222", type: "unstarted", wipLimit: null },
      { id: STATE_A_DONE, orgId: ORG, projectId: PROJECT_A, name: "Done", order: 2, color: "#333333", type: "completed", wipLimit: null },
      { id: STATE_B_BACKLOG, orgId: ORG, projectId: PROJECT_B, name: "Backlog", order: 0, color: "#444444", type: "unstarted", wipLimit: null },
      { id: STATE_B_SHIPPED, orgId: ORG, projectId: PROJECT_B, name: "Shipped", order: 1, color: "#555555", type: "completed", wipLimit: null },
    ],
    tickets: [
      { id: TICKET_A, orgId: ORG, projectId: PROJECT_A, status: "Todo", deletedAt: null },
      { id: TICKET_B, orgId: ORG, projectId: PROJECT_B, status: "Backlog", deletedAt: null },
    ],
    fields: [
      { id: FIELD_A, orgId: ORG, entityType: "build_ticket", projectId: PROJECT_A, key: "severity", label: "Severity", fieldType: "text", options: null, isRequired: false, displayOrder: 0, createdAt: new Date(0) },
      { id: FIELD_B, orgId: ORG, entityType: "build_ticket", projectId: PROJECT_B, key: "priority", label: "Priority", fieldType: "text", options: null, isRequired: false, displayOrder: 0, createdAt: new Date(0) },
    ],
    webhooks: [
      { id: HOOK_A, orgId: ORG, projectId: PROJECT_A, url: "https://a.example", events: ["ticket.created"], isActive: true, secret: "sa", createdBy: "user-7", createdAt: new Date(0) },
      { id: HOOK_B, orgId: ORG, projectId: PROJECT_B, url: "https://b.example", events: ["ticket.created"], isActive: true, secret: "sb", createdBy: "user-7", createdAt: new Date(0) },
    ],
  };
}

function makeU(orgId: string = ORG): CurrentUserContext {
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

function makeAccess(): AccessService {
  return {
    resolveUserPermissions: jest.fn().mockResolvedValue(new Set<string>(["build:manage"])),
  } as unknown as AccessService;
}

function makeStatesService(store: Store, afterFirstLookup?: () => void) {
  const transaction = jest.fn();
  let lookups = 0;

  const selectChain = () => ({
    from: (table: unknown) => {
      if (table !== projectStatuses) throw new Error(`unexpected select from ${String(table)}`);
      return {
        where: (where: unknown) => {
          const rows = () => {
            const result = store.statuses.filter((row) => matches(where, row)).map((row) => ({ ...row }));
            lookups += 1;
            if (lookups === 1 && afterFirstLookup) afterFirstLookup();
            return result;
          };
          return { limit: async () => rows(), orderBy: () => ({ limit: async () => rows() }) };
        },
      };
    },
  });

  const updateBuilder = (table: unknown) => ({
    set: (values: Row) => ({
      where: (where: unknown) => {
        const target = table === projectStatuses ? store.statuses : table === tickets ? store.tickets : [];
        const hit = target.filter((row) => matches(where, row));
        for (const row of hit) assign(row, values);
        return Object.assign(Promise.resolve(hit.length), {
          returning: async () => hit.map((row) => ({ ...row })),
        });
      },
    }),
  });

  const deleteBuilder = (table: unknown) => ({
    where: async (where: unknown) => {
      if (table !== projectStatuses) return;
      store.statuses = store.statuses.filter((row) => !matches(where, row));
    },
  });

  transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
    callback({ execute: async () => [], update: updateBuilder, delete: deleteBuilder }),
  );

  const db = {
    query: {
      projects: {
        findFirst: jest.fn(async (args: { where?: unknown }) =>
          store.projects.find((row) => matches(args.where, row)),
        ),
      },
    },
    select: jest.fn(() => selectChain()),
    update: updateBuilder,
    delete: deleteBuilder,
    transaction,
  } as unknown as Db;

  return { svc: new ProjectsCustomStatesService(db, makeAccess()), transaction };
}

function makeFieldsService(store: Store) {
  const db = {
    query: {
      projects: {
        findFirst: jest.fn(async (args: { where?: unknown }) =>
          store.projects.find((row) => matches(args.where, row)),
        ),
      },
    },
    update: (table: unknown) => ({
      set: (values: Row) => ({
        where: (where: unknown) => {
          const hit = table === customFieldDefinitions ? store.fields.filter((row) => matches(where, row)) : [];
          for (const row of hit) assign(row, values);
          return { returning: async () => hit.map((row) => ({ ...row })) };
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: (where: unknown) => ({
        returning: async () => {
          const hit = table === customFieldDefinitions ? store.fields.filter((row) => matches(where, row)) : [];
          store.fields = store.fields.filter((row) => !hit.includes(row));
          return hit.map((row) => ({ ...row }));
        },
      }),
    }),
  } as unknown as Db;

  return new ProjectsCustomFieldsService(db);
}

function makeWebhooksService(store: Store, afterOwnershipCheck?: () => void) {
  const deleteStatements = jest.fn();

  const db = {
    select: jest.fn(() => ({
      from: (table: unknown) => ({
        where: (where: unknown) => ({
          limit: async () => {
            const rows =
              table === projectWebhooks
                ? store.webhooks.filter((row) => matches(where, row)).map((row) => ({ id: row.id }))
                : [];
            if (afterOwnershipCheck) afterOwnershipCheck();
            return rows;
          },
        }),
      }),
    })),
    delete: (table: unknown) => ({
      where: (where: unknown) => ({
        returning: async () => {
          deleteStatements();
          const hit = table === projectWebhooks ? store.webhooks.filter((row) => matches(where, row)) : [];
          store.webhooks = store.webhooks.filter((row) => !hit.includes(row));
          return hit.map((row) => ({ ...row }));
        },
      }),
    }),
  } as unknown as Db;

  return { svc: new ProjectsWebhooksService(db), deleteStatements };
}

const rename = (name: string): UpdateCustomStateInput => ({ name });

describe("ProjectsCustomStatesService — custom state lookups bind to the URL project", () => {
  it("updateCustomState leaves a same-org state owned by another project untouched and answers 404", async () => {
    const store = makeStore();
    const { svc, transaction } = makeStatesService(store);

    await expect(
      svc.updateCustomState(makeU(), PROJECT_A, STATE_B_BACKLOG, rename("Hijacked")),
    ).rejects.toThrow(NotFoundException);
    expect(store.statuses.find((row) => row.id === STATE_B_BACKLOG)?.name).toBe("Backlog");
    expect(transaction).not.toHaveBeenCalled();
  });

  it("updateCustomState renames the state that belongs to the URL project (control)", async () => {
    const store = makeStore();
    const { svc, transaction } = makeStatesService(store);

    await expect(
      svc.updateCustomState(makeU(), PROJECT_A, STATE_A_TODO, rename("Triage")),
    ).resolves.toMatchObject({ id: STATE_A_TODO, name: "Triage", projectId: PROJECT_A });
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("updateCustomState cascades the rename onto the URL project's tickets only", async () => {
    const store = makeStore();
    const { svc } = makeStatesService(store);

    await svc.updateCustomState(makeU(), PROJECT_A, STATE_A_TODO, rename("Triage"));
    expect(store.tickets.find((row) => row.id === TICKET_A)?.status).toBe("Triage");
    expect(store.tickets.find((row) => row.id === TICKET_B)?.status).toBe("Backlog");
  });

  it("updateCustomState refuses a state in the caller's project from another organisation", async () => {
    const store = makeStore();
    const { svc } = makeStatesService(store);

    await expect(
      svc.updateCustomState(makeU(OTHER_ORG), PROJECT_A, STATE_A_TODO, rename("Triage")),
    ).rejects.toThrow(NotFoundException);
    expect(store.statuses.find((row) => row.id === STATE_A_TODO)?.name).toBe("Todo");
  });

  it("updateCustomState scopes the duplicate-name check to the URL project, so another project's name is free", async () => {
    const store = makeStore();
    const { svc } = makeStatesService(store);

    await expect(
      svc.updateCustomState(makeU(), PROJECT_A, STATE_A_TODO, rename("Shipped")),
    ).resolves.toMatchObject({ id: STATE_A_TODO, name: "Shipped" });
  });

  it("updateCustomState still refuses a name already used inside the URL project (control)", async () => {
    const store = makeStore();
    const { svc } = makeStatesService(store);

    await expect(
      svc.updateCustomState(makeU(), PROJECT_A, STATE_A_TODO, rename("Doing")),
    ).rejects.toThrow(ConflictException);
    expect(store.statuses.find((row) => row.id === STATE_A_TODO)?.name).toBe("Todo");
  });

  it("deleteCustomState does not delete a same-org state owned by another project", async () => {
    const store = makeStore();
    const { svc, transaction } = makeStatesService(store);

    await expect(svc.deleteCustomState(makeU(), PROJECT_A, STATE_B_BACKLOG)).rejects.toThrow(
      NotFoundException,
    );
    expect(store.statuses.some((row) => row.id === STATE_B_BACKLOG)).toBe(true);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("deleteCustomState deletes the state that belongs to the URL project (control)", async () => {
    const store = makeStore();
    const { svc } = makeStatesService(store);

    await expect(svc.deleteCustomState(makeU(), PROJECT_A, STATE_A_TODO)).resolves.toEqual({
      success: true,
    });
    expect(store.statuses.some((row) => row.id === STATE_A_TODO)).toBe(false);
    expect(store.statuses.some((row) => row.id === STATE_B_BACKLOG)).toBe(true);
  });

  it("deleteCustomState reassigns only the URL project's tickets to the fallback status", async () => {
    const store = makeStore();
    const { svc } = makeStatesService(store);

    await svc.deleteCustomState(makeU(), PROJECT_A, STATE_A_TODO);
    expect(store.tickets.find((row) => row.id === TICKET_A)?.status).toBe("Doing");
    expect(store.tickets.find((row) => row.id === TICKET_B)?.status).toBe("Backlog");
  });

  it("updateCustomState writes nothing when the state leaves the URL project between the lookup and the UPDATE", async () => {
    const store = makeStore();
    const move = () => {
      const row = store.statuses.find((candidate) => candidate.id === STATE_A_TODO);
      if (row) row.projectId = PROJECT_B;
    };
    const { svc } = makeStatesService(store, move);

    await expect(
      svc.updateCustomState(makeU(), PROJECT_A, STATE_A_TODO, rename("Triage")),
    ).rejects.toThrow(NotFoundException);
    expect(store.statuses.find((row) => row.id === STATE_A_TODO)?.name).toBe("Todo");
  });

  it("deleteCustomState deletes nothing when the state leaves the URL project between the lookup and the DELETE", async () => {
    const store = makeStore();
    const move = () => {
      const row = store.statuses.find((candidate) => candidate.id === STATE_A_TODO);
      if (row) row.projectId = PROJECT_B;
    };
    const { svc } = makeStatesService(store, move);

    await svc.deleteCustomState(makeU(), PROJECT_A, STATE_A_TODO);
    expect(store.statuses.some((row) => row.id === STATE_A_TODO)).toBe(true);
  });

  it("deleteCustomState counts siblings within the URL project, not the whole organisation", async () => {
    const store = makeStore();
    store.statuses = store.statuses.filter(
      (row) => row.projectId === PROJECT_B || row.id === STATE_A_TODO,
    );
    const { svc } = makeStatesService(store);

    await expect(svc.deleteCustomState(makeU(), PROJECT_A, STATE_A_TODO)).rejects.toThrow(
      "At least one workflow status is required",
    );
    expect(store.statuses.some((row) => row.id === STATE_A_TODO)).toBe(true);
  });
});

describe("ProjectsCustomFieldsService — custom field lookups bind to the URL project", () => {
  it("updateField leaves a same-org field owned by another project untouched and answers 404", async () => {
    const store = makeStore();
    const svc = makeFieldsService(store);

    await expect(
      svc.updateField(ORG, PROJECT_A, FIELD_B, { name: "Hijacked" } as UpdateCustomFieldInput),
    ).rejects.toThrow(NotFoundException);
    expect(store.fields.find((row) => row.id === FIELD_B)?.label).toBe("Priority");
  });

  it("updateField updates the field that belongs to the URL project (control)", async () => {
    const store = makeStore();
    const svc = makeFieldsService(store);

    await expect(
      svc.updateField(ORG, PROJECT_A, FIELD_A, { name: "Blast radius" } as UpdateCustomFieldInput),
    ).resolves.toMatchObject({ id: FIELD_A, name: "Blast radius", projectId: PROJECT_A });
  });

  it("updateField answers 404 for a project id that is not in the caller's organisation", async () => {
    const store = makeStore();
    const svc = makeFieldsService(store);

    await expect(
      svc.updateField(ORG, ABSENT_PROJECT, FIELD_A, { name: "Hijacked" } as UpdateCustomFieldInput),
    ).rejects.toThrow(NotFoundException);
    expect(store.fields.find((row) => row.id === FIELD_A)?.label).toBe("Severity");
  });

  it("updateField answers 404 when another organisation names the caller's project", async () => {
    const store = makeStore();
    const svc = makeFieldsService(store);

    await expect(
      svc.updateField(OTHER_ORG, PROJECT_A, FIELD_A, { name: "Hijacked" } as UpdateCustomFieldInput),
    ).rejects.toThrow(NotFoundException);
    expect(store.fields.find((row) => row.id === FIELD_A)?.label).toBe("Severity");
  });

  it("updateField answers 404 when the URL project is soft-deleted", async () => {
    const store = makeStore();
    const project = store.projects.find((row) => row.id === PROJECT_A);
    if (project) project.deletedAt = new Date(0);
    const svc = makeFieldsService(store);

    await expect(
      svc.updateField(ORG, PROJECT_A, FIELD_A, { name: "Hijacked" } as UpdateCustomFieldInput),
    ).rejects.toThrow(NotFoundException);
    expect(store.fields.find((row) => row.id === FIELD_A)?.label).toBe("Severity");
  });

  it("deleteField does not delete a same-org field owned by another project", async () => {
    const store = makeStore();
    const svc = makeFieldsService(store);

    await expect(svc.deleteField(ORG, PROJECT_A, FIELD_B)).rejects.toThrow(NotFoundException);
    expect(store.fields.some((row) => row.id === FIELD_B)).toBe(true);
  });

  it("deleteField deletes the field that belongs to the URL project (control)", async () => {
    const store = makeStore();
    const svc = makeFieldsService(store);

    await expect(svc.deleteField(ORG, PROJECT_A, FIELD_A)).resolves.toEqual({ success: true });
    expect(store.fields.some((row) => row.id === FIELD_A)).toBe(false);
    expect(store.fields.some((row) => row.id === FIELD_B)).toBe(true);
  });

  it("deleteField answers 404 for a project id that is not in the caller's organisation", async () => {
    const store = makeStore();
    const svc = makeFieldsService(store);

    await expect(svc.deleteField(ORG, ABSENT_PROJECT, FIELD_A)).rejects.toThrow(NotFoundException);
    expect(store.fields.some((row) => row.id === FIELD_A)).toBe(true);
  });

  it("deleteField answers 404 when the URL project is soft-deleted", async () => {
    const store = makeStore();
    const project = store.projects.find((row) => row.id === PROJECT_A);
    if (project) project.deletedAt = new Date(0);
    const svc = makeFieldsService(store);

    await expect(svc.deleteField(ORG, PROJECT_A, FIELD_A)).rejects.toThrow(NotFoundException);
    expect(store.fields.some((row) => row.id === FIELD_A)).toBe(true);
  });
});

describe("ProjectsWebhooksService — webhook deletion binds to the URL project", () => {
  it("deleteWebhook refuses a same-org webhook owned by another project before issuing any DELETE", async () => {
    const store = makeStore();
    const { svc, deleteStatements } = makeWebhooksService(store);

    await expect(svc.deleteWebhook(ORG, PROJECT_A, HOOK_B)).rejects.toThrow(NotFoundException);
    expect(store.webhooks.some((row) => row.id === HOOK_B)).toBe(true);
    expect(deleteStatements).not.toHaveBeenCalled();
  });

  it("deleteWebhook deletes the webhook that belongs to the URL project (control)", async () => {
    const store = makeStore();
    const { svc, deleteStatements } = makeWebhooksService(store);

    await expect(svc.deleteWebhook(ORG, PROJECT_A, HOOK_A)).resolves.toBeUndefined();
    expect(store.webhooks.some((row) => row.id === HOOK_A)).toBe(false);
    expect(store.webhooks.some((row) => row.id === HOOK_B)).toBe(true);
    expect(deleteStatements).toHaveBeenCalledTimes(1);
  });

  it("deleteWebhook refuses a webhook in the caller's project from another organisation before issuing any DELETE", async () => {
    const store = makeStore();
    const { svc, deleteStatements } = makeWebhooksService(store);

    await expect(svc.deleteWebhook(OTHER_ORG, PROJECT_A, HOOK_A)).rejects.toThrow(
      NotFoundException,
    );
    expect(store.webhooks.some((row) => row.id === HOOK_A)).toBe(true);
    expect(deleteStatements).not.toHaveBeenCalled();
  });

  it("deleteWebhook deletes nothing when the webhook leaves the URL project between the ownership check and the DELETE", async () => {
    const store = makeStore();
    const move = () => {
      const row = store.webhooks.find((candidate) => candidate.id === HOOK_A);
      if (row) row.projectId = PROJECT_B;
    };
    const { svc } = makeWebhooksService(store, move);

    await expect(svc.deleteWebhook(ORG, PROJECT_A, HOOK_A)).rejects.toThrow(NotFoundException);
    expect(store.webhooks.some((row) => row.id === HOOK_A)).toBe(true);
  });
});
