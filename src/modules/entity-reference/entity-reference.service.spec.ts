import { EntityReferenceService } from "./entity-reference.service";
import type {
  EntityActionResult,
  EntityActor,
  EntityAdapter,
  EntityReference,
  EntityResolution,
} from "./entity-reference.types";

const ACTOR: EntityActor = {
  orgId: "org_1",
  userId: "user_1",
  isOrgOwner: false,
};

function card(reference: EntityReference, title: string): EntityResolution {
  return {
    status: "resolved",
    card: {
      type: reference.type,
      id: reference.id,
      title,
      subtitle: null,
      status: null,
      href: `/${reference.type}/${reference.id}`,
    },
  };
}

function stubAdapter(overrides: Partial<EntityAdapter> = {}): EntityAdapter {
  return {
    moduleKey: "build",
    types: ["ticket"],
    resolve: jest.fn(async (_actor, references) =>
      references.map((reference) => card(reference, `Ticket ${reference.id}`)),
    ),
    actionsFor: jest.fn(async (_actor, references) => references.map(() => [])),
    submitAction: jest.fn(
      async (): Promise<EntityActionResult> => ({
        ok: true,
        message: null,
        data: {},
      }),
    ),
    ...overrides,
  };
}

function makeService(
  adapters: EntityAdapter[],
  enabledModules: string[] = ["build", "crm"],
): EntityReferenceService {
  return new EntityReferenceService(adapters, {
    isModuleEnabled: async (_orgId: string, moduleKey: string) =>
      enabledModules.includes(moduleKey),
  });
}

describe("EntityReferenceService", () => {
  describe("resolve", () => {
    it("returns unresolved for a type no adapter claims", async () => {
      const service = makeService([stubAdapter()]);

      const [result] = await service.resolve(ACTOR, [
        { type: "unicorn", id: "1" },
      ]);

      expect(result).toEqual({
        status: "unresolved",
        reference: { type: "unicorn", id: "1" },
      });
    });

    it("returns unresolved when the owning module is disabled for the org", async () => {
      const adapter = stubAdapter();
      const service = makeService([adapter], []);

      const [result] = await service.resolve(ACTOR, [
        { type: "ticket", id: "7" },
      ]);

      expect(result).toEqual({
        status: "unresolved",
        reference: { type: "ticket", id: "7" },
      });
      expect(adapter.resolve).not.toHaveBeenCalled();
    });

    it("resolves the rest of a batch when one reference is unresolvable", async () => {
      const service = makeService([stubAdapter()]);

      const results = await service.resolve(ACTOR, [
        { type: "ticket", id: "1" },
        { type: "unicorn", id: "2" },
        { type: "ticket", id: "3" },
      ]);

      expect(results.map((result) => result.status)).toEqual([
        "resolved",
        "unresolved",
        "resolved",
      ]);
    });

    it("returns results positionally aligned with the references given", async () => {
      const service = makeService([
        stubAdapter(),
        stubAdapter({ moduleKey: "crm", types: ["deal"] }),
      ]);

      const results = await service.resolve(ACTOR, [
        { type: "deal", id: "9" },
        { type: "ticket", id: "4" },
      ]);

      expect(results).toEqual([
        card({ type: "deal", id: "9" }, "Ticket 9"),
        card({ type: "ticket", id: "4" }, "Ticket 4"),
      ]);
    });

    it("hands each adapter its whole batch in one call", async () => {
      const adapter = stubAdapter();
      const service = makeService([adapter]);

      await service.resolve(ACTOR, [
        { type: "ticket", id: "1" },
        { type: "ticket", id: "2" },
      ]);

      expect(adapter.resolve).toHaveBeenCalledTimes(1);
      expect(adapter.resolve).toHaveBeenCalledWith(ACTOR, [
        { type: "ticket", id: "1" },
        { type: "ticket", id: "2" },
      ]);
    });
  });

  describe("actionsFor", () => {
    it("offers no actions for a type no adapter claims", async () => {
      const service = makeService([stubAdapter()]);

      const [actions] = await service.actionsFor(ACTOR, [
        { type: "unicorn", id: "1" },
      ]);

      expect(actions).toEqual([]);
    });

    it("offers no actions when the owning module is disabled", async () => {
      const adapter = stubAdapter();
      const service = makeService([adapter], []);

      const [actions] = await service.actionsFor(ACTOR, [
        { type: "ticket", id: "1" },
      ]);

      expect(actions).toEqual([]);
      expect(adapter.actionsFor).not.toHaveBeenCalled();
    });
  });

  describe("isKnownType", () => {
    it("claims a type an adapter registered", () => {
      expect(makeService([stubAdapter()]).isKnownType("ticket")).toBe(true);
    });

    it("refuses a type no adapter registered", () => {
      expect(makeService([stubAdapter()]).isKnownType("unicorn")).toBe(false);
    });
  });
});
