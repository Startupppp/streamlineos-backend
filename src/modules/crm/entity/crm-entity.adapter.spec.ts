import { CrmEntityAdapter } from "./crm-entity.adapter";
import type { DataScope } from "../../access/access.types";
import type { EntityActor } from "../../entity-reference/entity-reference.types";
import type { Db } from "../../../db/drizzle.module";

const ACTOR: EntityActor = {
  orgId: "org_1",
  userId: "user_1",
  isOrgOwner: false,
};

function makeAdapter(keys: string[], rows: Record<string, unknown>[] = []) {
  const limit = jest.fn(async () => rows);
  const where = jest.fn(() => ({ limit }));
  const from = jest.fn(() => ({ where }));
  const select = jest.fn(() => ({ from }));
  const db = { select } as unknown as Db;
  const access = {
    resolveUserPermissions: jest.fn(
      async () => new Map<string, DataScope>(keys.map((key) => [key, "all"])),
    ),
  };
  return { adapter: new CrmEntityAdapter(db, access), select };
}

function makeAdapterScoped(
  entries: ReadonlyArray<[string, DataScope]>,
  rows: Record<string, unknown>[] = [],
) {
  const limit = jest.fn(async () => rows);
  const where = jest.fn(() => ({ limit }));
  const from = jest.fn(() => ({ where }));
  const select = jest.fn(() => ({ from }));
  const db = { select } as unknown as Db;
  const access = {
    resolveUserPermissions: jest.fn(
      async () => new Map<string, DataScope>(entries),
    ),
  };
  return { adapter: new CrmEntityAdapter(db, access), select };
}

describe("CrmEntityAdapter", () => {
  it("claims the two CRM reference types", () => {
    const { adapter } = makeAdapter([]);
    expect([...adapter.types].sort()).toEqual(["client", "deal"]);
  });

  it.each([
    ["client", "crm:clients:read"],
    ["deal", "crm:deals:read"],
  ])("returns unresolved for a %s without %s, without reading", async (type) => {
    const { adapter, select } = makeAdapter([]);

    const [result] = await adapter.resolve(ACTOR, [{ type, id: "1" }]);

    expect(result).toEqual({
      status: "unresolved",
      reference: { type, id: "1" },
    });
    expect(select).not.toHaveBeenCalled();
  });

  it("builds a client card, which is the record the old resolver leaked", async () => {
    const { adapter } = makeAdapter(
      ["crm:clients:read"],
      [{ id: 5, name: "Acme Ltd", company: "Acme", status: "ACTIVE" }],
    );

    const [result] = await adapter.resolve(ACTOR, [{ type: "client", id: "5" }]);

    expect(result).toEqual({
      status: "resolved",
      card: {
        type: "client",
        id: "5",
        title: "Acme Ltd",
        subtitle: "Acme",
        status: "ACTIVE",
        href: "/crm/contacts/5",
      },
    });
  });

  it("offers no actions on a CRM record", async () => {
    const { adapter } = makeAdapter(["crm:deals:read"]);

    const [actions] = await adapter.actionsFor(ACTOR, [
      { type: "deal", id: "1" },
    ]);

    expect(actions).toEqual([]);
  });

  describe("scope enforcement", () => {
    const CLIENT_ROW = { id: 5, name: "Acme Ltd", company: "Acme", status: "ACTIVE" };
    const DEAL_ROW = { id: 9, name: "Big Deal", stage: "PROPOSAL" };

    it("scope none: returns unresolved without hitting the database", async () => {
      const { adapter, select } = makeAdapterScoped([
        ["crm:clients:read", "none"],
      ]);

      const [result] = await adapter.resolve(ACTOR, [
        { type: "client", id: "5" },
      ]);

      expect(result.status).toBe("unresolved");
      expect(select).not.toHaveBeenCalled();
    });

    it("scope own: does not resolve a client the actor does not manage", async () => {
      const { adapter } = makeAdapterScoped([["crm:clients:read", "own"]], []);

      const [result] = await adapter.resolve(ACTOR, [
        { type: "client", id: "5" },
      ]);

      expect(result.status).toBe("unresolved");
    });

    it("scope own: resolves a client the actor manages", async () => {
      const { adapter } = makeAdapterScoped(
        [["crm:clients:read", "own"]],
        [CLIENT_ROW],
      );

      const [result] = await adapter.resolve(ACTOR, [
        { type: "client", id: "5" },
      ]);

      expect(result.status).toBe("resolved");
    });

    it("scope own: does not resolve a deal the actor is not assigned to", async () => {
      const { adapter } = makeAdapterScoped([["crm:deals:read", "own"]], []);

      const [result] = await adapter.resolve(ACTOR, [
        { type: "deal", id: "9" },
      ]);

      expect(result.status).toBe("unresolved");
    });

    it("org owner resolves a client without holding any permission key", async () => {
      const owner: EntityActor = { ...ACTOR, isOrgOwner: true };
      const { adapter } = makeAdapterScoped([], [CLIENT_ROW]);

      const [result] = await adapter.resolve(owner, [
        { type: "client", id: "5" },
      ]);

      expect(result.status).toBe("resolved");
    });

    it("org owner resolves a deal without holding any permission key", async () => {
      const owner: EntityActor = { ...ACTOR, isOrgOwner: true };
      const { adapter } = makeAdapterScoped([], [DEAL_ROW]);

      const [result] = await adapter.resolve(owner, [
        { type: "deal", id: "9" },
      ]);

      expect(result.status).toBe("resolved");
    });
  });
});
