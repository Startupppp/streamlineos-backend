import { CACHE_KEYS } from "../common/cache/cache-keys";
import type { CacheService } from "../common/cache/cache.service";
import type { Db } from "../db/drizzle.module";
import type { EmploymentFactsService } from "../modules/directory/employment-facts.service";
import { MeService } from "./me.service";

const afterCommitHooks: Array<() => Promise<void>> = [];
let ambientContextPresent = true;

jest.mock("../common/tenant/tenant-context", () => ({
  ...jest.requireActual("../common/tenant/tenant-context"),
  registerAfterCommit: (work: () => Promise<void>) => {
    if (!ambientContextPresent) return false;
    afterCommitHooks.push(work);
    return true;
  },
}));

interface TransactionCall {
  invoked: boolean;
  setFields: Record<string, unknown> | null;
}

function buildDb(call: TransactionCall): Db {
  const tx = {
    update: () => ({
      set: (fields: Record<string, unknown>) => {
        call.setFields = fields;
        return {
          where: () => Promise.resolve(undefined),
        };
      },
    }),
  };
  const db = {
    transaction: async (fn: (inner: unknown) => Promise<unknown>) => {
      call.invoked = true;
      return fn(tx);
    },
  };
  return db as unknown as Db;
}

function buildCache(invalidated: string[]): CacheService {
  const cache = {
    invalidate: (key: string) => {
      invalidated.push(key);
      return Promise.resolve(undefined);
    },
  };
  return cache as unknown as CacheService;
}

function buildEmploymentFacts(): EmploymentFactsService {
  return {} as unknown as EmploymentFactsService;
}

function buildService(call: TransactionCall, invalidated: string[]): MeService {
  return new MeService(
    buildDb(call),
    buildEmploymentFacts(),
    buildCache(invalidated),
  );
}

describe("MeService.updateProfile invalidates the cached session payload", () => {
  const userId = "user-1";
  const sessionKey = CACHE_KEYS.userSession(userId);

  beforeEach(() => {
    afterCommitHooks.length = 0;
    ambientContextPresent = true;
  });

  it("ANTI-VACUITY: the transaction callback really runs and writes the fields", async () => {
    const call: TransactionCall = { invoked: false, setFields: null };
    const invalidated: string[] = [];
    await buildService(call, invalidated).updateProfile(userId, "org-1", {
      name: "Renamed",
    });
    expect(call.invoked).toBe(true);
    expect(call.setFields).toEqual({ name: "Renamed" });
  });

  it("busts the session key when the display name changes", async () => {
    const call: TransactionCall = { invoked: false, setFields: null };
    const invalidated: string[] = [];
    await buildService(call, invalidated).updateProfile(userId, "org-1", {
      name: "Renamed",
    });
    expect(invalidated).toEqual([sessionKey]);
  });

  it("busts the session key when the avatar changes", async () => {
    const call: TransactionCall = { invoked: false, setFields: null };
    const invalidated: string[] = [];
    await buildService(call, invalidated).updateProfile(userId, "org-1", {
      image: "https://cdn.example.com/a.png",
    });
    expect(invalidated).toEqual([sessionKey]);
  });

  it("busts the session key when first and last name change", async () => {
    const call: TransactionCall = { invoked: false, setFields: null };
    const invalidated: string[] = [];
    await buildService(call, invalidated).updateProfile(userId, "org-1", {
      firstName: "Ada",
      lastName: "Lovelace",
    });
    expect(invalidated).toEqual([sessionKey]);
  });

  it("busts again after the ambient transaction commits, not only before it", async () => {
    const call: TransactionCall = { invoked: false, setFields: null };
    const invalidated: string[] = [];
    await buildService(call, invalidated).updateProfile(userId, "org-1", {
      name: "Renamed",
    });
    expect(invalidated).toEqual([sessionKey]);
    expect(afterCommitHooks).toHaveLength(1);
    for (const hook of afterCommitHooks) await hook();
    expect(invalidated).toEqual([sessionKey, sessionKey]);
  });

  it("still busts inline when there is no ambient transaction to defer to", async () => {
    ambientContextPresent = false;
    const call: TransactionCall = { invoked: false, setFields: null };
    const invalidated: string[] = [];
    await buildService(call, invalidated).updateProfile(userId, "org-1", {
      name: "Renamed",
    });
    expect(afterCommitHooks).toHaveLength(0);
    expect(invalidated).toEqual([sessionKey]);
  });

  it("does not bust for a field the session payload never carries", async () => {
    const call: TransactionCall = { invoked: false, setFields: null };
    const invalidated: string[] = [];
    await buildService(call, invalidated).updateProfile(userId, "org-1", {
      phone: "+911234567890",
    });
    expect(call.setFields).toEqual({ phone: "+911234567890" });
    expect(invalidated).toEqual([]);
  });
});
