import { BuildEntityAdapter } from "./build-entity.adapter";
import type { DataScope } from "../../access/access.types";
import type { EntityActor } from "../../entity-reference/entity-reference.types";
import type { Db } from "../../../db/drizzle.module";

const ACTOR: EntityActor = {
  orgId: "org_1",
  userId: "user_1",
  isOrgOwner: false,
};

function accessStub(keys: string[]) {
  const map = new Map<string, DataScope>(
    keys.map((key) => [key, "all" as DataScope]),
  );
  return { resolveUserPermissions: jest.fn(async () => map) };
}

/**
 * A read that never happens cannot leak. Every authority test below asserts the
 * refusal by proving the database was not touched, which is the property that
 * failed in the resolver this adapter replaces.
 */
function dbStub(rows: Record<string, unknown>[] = []) {
  const limit = jest.fn(async () => rows);
  const where = jest.fn(() => ({ limit }));
  const chain: { where: typeof where; innerJoin: () => unknown } = {
    where,
    innerJoin: () => chain,
  };
  const innerJoin = jest.fn(() => chain);
  chain.innerJoin = innerJoin;
  const from = jest.fn(() => chain);
  const select = jest.fn(() => ({ from }));
  return { select, from, innerJoin, where, limit } as unknown as Db & {
    select: jest.Mock;
  };
}

function makeAdapter(keys: string[], rows: Record<string, unknown>[] = []) {
  const db = dbStub(rows);
  const access = accessStub(keys);
  const actions = {
    run: jest.fn(async () => ({ ok: true as const, message: null, data: {} })),
  };
  return {
    adapter: new BuildEntityAdapter(
      db,
      access,
      actions as unknown as ConstructorParameters<typeof BuildEntityAdapter>[2],
    ),
    db,
    access,
    actions,
  };
}

describe("BuildEntityAdapter", () => {
  it("claims the Build reference types, including the legacy ticket name", () => {
    const { adapter } = makeAdapter([]);
    expect([...adapter.types].sort()).toEqual([
      "incident",
      "project",
      "release",
      "sprint",
      "task",
      "ticket",
    ]);
  });

  /**
   * Entity channels were stored under `task` before message references settled
   * on `ticket`. Existing rows must keep resolving, and under the same key.
   */
  it("resolves the legacy `task` type as a ticket, behind the ticket read key", async () => {
    const { adapter, db } = makeAdapter([]);
    const [refused] = await adapter.resolve(ACTOR, [{ type: "task", id: "1" }]);
    expect(refused.status).toBe("unresolved");
    expect(db.select).not.toHaveBeenCalled();

    const allowed = makeAdapter(
      ["build:tickets:view"],
      [{ id: 1, title: "T", status: "TODO", ticketNumber: 3, projectKey: "W" }],
    );
    const [result] = await allowed.adapter.resolve(ACTOR, [
      { type: "task", id: "1" },
    ]);

    expect(result).toEqual({
      status: "resolved",
      card: {
        type: "task",
        id: "1",
        title: "T",
        subtitle: "W-3",
        status: "TODO",
        href: "/build/tickets/1",
      },
    });
  });

  describe("read authority per type", () => {
    const cases: ReadonlyArray<[string, string]> = [
      ["ticket", "build:tickets:view"],
      ["project", "build:view"],
      ["sprint", "build:sprints:view"],
      ["release", "build:view"],
      ["incident", "build:incidents:view"],
    ];

    it.each(cases)(
      "returns unresolved for a %s when the actor lacks %s",
      async (type, _key) => {
        const { adapter, db } = makeAdapter([]);

        const [result] = await adapter.resolve(ACTOR, [{ type, id: "1" }]);

        expect(result).toEqual({
          status: "unresolved",
          reference: { type, id: "1" },
        });
        expect(db.select).not.toHaveBeenCalled();
      },
    );

    it.each(cases)(
      "reads a %s when the actor holds %s",
      async (type, key) => {
        const { adapter, db } = makeAdapter([key], []);

        await adapter.resolve(ACTOR, [{ type, id: "1" }]);

        expect(db.select).toHaveBeenCalled();
      },
    );
  });

  it("returns unresolved when the record does not exist", async () => {
    const { adapter } = makeAdapter(["build:tickets:view"], []);

    const [result] = await adapter.resolve(ACTOR, [
      { type: "ticket", id: "404" },
    ]);

    expect(result).toEqual({
      status: "unresolved",
      reference: { type: "ticket", id: "404" },
    });
  });

  it("returns unresolved for a non-numeric id without reading", async () => {
    const { adapter, db } = makeAdapter(["build:tickets:view"]);

    const [result] = await adapter.resolve(ACTOR, [
      { type: "ticket", id: "'; DROP TABLE tickets; --" },
    ]);

    expect(result.status).toBe("unresolved");
    expect(db.select).not.toHaveBeenCalled();
  });

  it("builds a ticket card from the record's current values", async () => {
    const { adapter } = makeAdapter(
      ["build:tickets:view"],
      [
        {
          id: 12,
          title: "Login is broken",
          status: "IN_PROGRESS",
          ticketNumber: 42,
          projectKey: "WEB",
        },
      ],
    );

    const [result] = await adapter.resolve(ACTOR, [
      { type: "ticket", id: "12" },
    ]);

    expect(result).toEqual({
      status: "resolved",
      card: {
        type: "ticket",
        id: "12",
        title: "Login is broken",
        subtitle: "WEB-42",
        status: "IN_PROGRESS",
        href: "/build/tickets/12",
      },
    });
  });

  describe("actionsFor", () => {
    it("offers no actions on a ticket the actor cannot read", async () => {
      const { adapter } = makeAdapter([]);

      const [actions] = await adapter.actionsFor(ACTOR, [
        { type: "ticket", id: "1" },
      ]);

      expect(actions).toEqual([]);
    });

    it("offers only the ticket actions whose write key the actor holds", async () => {
      const { adapter } = makeAdapter(
        ["build:tickets:view", "build:tickets:assign"],
        [{ id: 1, title: "T", status: "TODO", ticketNumber: 1, projectKey: "W" }],
      );

      const [actions] = await adapter.actionsFor(ACTOR, [
        { type: "ticket", id: "1" },
      ]);

      expect(actions.map((action) => action.id)).toEqual(["assign"]);
    });

    it("offers create-ticket on a project when the actor may create tickets", async () => {
      const { adapter } = makeAdapter(
        ["build:view", "build:tickets:create"],
        [{ id: 1, name: "P", status: "ACTIVE", key: "P" }],
      );

      const [actions] = await adapter.actionsFor(ACTOR, [
        { type: "project", id: "1" },
      ]);

      expect(actions.map((action) => action.id)).toEqual(["create-ticket"]);
    });

    it("refuses an action the actor was not offered, submitted directly", async () => {
      const { adapter, actions } = makeAdapter(["build:tickets:view"]);

      const result = await adapter.submitAction(
        ACTOR,
        { type: "ticket", id: "1" },
        "assign",
        { assigneeId: "user_2" },
      );

      expect(result).toEqual({ ok: false, reason: "forbidden" });
      expect(actions.run).not.toHaveBeenCalled();
    });

    it("refuses an action id no catalog declares", async () => {
      const { adapter, actions } = makeAdapter([
        "build:tickets:view",
        "build:tickets:update",
      ]);

      const result = await adapter.submitAction(
        ACTOR,
        { type: "ticket", id: "1" },
        "delete-everything",
        {},
      );

      expect(result).toEqual({ ok: false, reason: "invalid" });
      expect(actions.run).not.toHaveBeenCalled();
    });

    it("runs an action the actor holds the key for", async () => {
      const { adapter, actions } = makeAdapter([
        "build:tickets:view",
        "build:tickets:assign",
      ]);

      await adapter.submitAction(ACTOR, { type: "ticket", id: "1" }, "assign", {
        assigneeId: "user_2",
      });

      expect(actions.run).toHaveBeenCalledWith(
        ACTOR,
        { type: "ticket", id: "1" },
        "assign",
        { assigneeId: "user_2" },
      );
    });

    it("offers no actions on a project when the actor may not create tickets", async () => {
      const { adapter } = makeAdapter(
        ["build:view"],
        [{ id: 1, name: "P", status: "ACTIVE", key: "P" }],
      );

      const [actions] = await adapter.actionsFor(ACTOR, [
        { type: "project", id: "1" },
      ]);

      expect(actions).toEqual([]);
    });
  });
});
