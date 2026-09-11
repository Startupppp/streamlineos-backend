import { ConflictException } from "@nestjs/common";
import { createOrganization } from "./lib/organization-creation";
import type { OrgCreationDeps } from "./lib/organization-creation";
import type { CreateOrganizationInput } from "./dto/organization.schemas";

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: jest.fn(),
}));
jest.mock("../../../common/region/cell-admission", () => ({
  chooseRegionForNewOrg: jest.fn().mockResolvedValue({ region: "primary" }),
}));
jest.mock("../../../common/region/placement-lookup", () => ({
  placeOrganization: jest.fn().mockResolvedValue(undefined),
  unplaceOrganization: jest.fn().mockResolvedValue(undefined),
}));

import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";

const runInNewTx = runInNewTenantTransaction as jest.MockedFunction<
  typeof runInNewTenantTransaction
>;

const ORG_ID = "org-new";
const USER = "user-1";
const INPUT: CreateOrganizationInput = {
  name: "New Org",
  slug: "new-org",
  billingEmail: null,
};

type Reservation = { kind: string; value: string };

/**
 * A reserve() that answers false for the named kinds, so the two 409s can be
 * provoked independently of each other.
 */
function makeDeps(unavailable: readonly string[]) {
  const released: Reservation[] = [];
  const claimed: Reservation[] = [];
  const stepsRun: string[] = [];
  let compensated = false;

  const saga = {
    begin: jest.fn().mockResolvedValue({
      saga: { sagaId: "saga-1", organizationId: ORG_ID },
      steps: [],
    }),
    runStep: jest.fn(
      async (_sagaId: string, name: string, work: () => Promise<unknown>) => {
        stepsRun.push(name);
        return work();
      },
    ),
    reserve: jest.fn((kind: string) =>
      Promise.resolve(!unavailable.includes(kind)),
    ),
    release: jest.fn((kind: string, value: string) => {
      released.push({ kind, value });
      return Promise.resolve();
    }),
    claim: jest.fn((kind: string, value: string) => {
      claimed.push({ kind, value });
      return Promise.resolve();
    }),
    complete: jest.fn().mockResolvedValue(undefined),
    compensate: jest.fn(
      async (
        _sagaId: string,
        handlers: Record<string, () => Promise<unknown>>,
      ) => {
        compensated = true;
        for (const step of stepsRun) await handlers[step]?.();
      },
    ),
  };

  const deps = {
    db: {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([{ email: "a@example.com" }]),
          }),
        }),
      }),
    },
    cache: { invalidate: jest.fn().mockResolvedValue(undefined) },
    saga,
    indexService: {
      refreshForUser: jest.fn().mockResolvedValue(undefined),
      touchLastActivated: jest.fn().mockResolvedValue(undefined),
    },
  } as unknown as OrgCreationDeps;

  return {
    deps,
    saga,
    released,
    claimed,
    wasCompensated: () => compensated,
  };
}

/**
 * Nothing exercised the creation saga before 2026-09-11 — the only existing
 * creation spec drives the controller with OrgProfileService mocked out, so the
 * body never ran. Neutering either reservation refusal, or the idempotency
 * guard in bootstrapCellOrganization, left all 374 organization tests green.
 * These cover the two refusals; the bootstrap guard is covered in
 * "resumes rather than re-inserting".
 */
describe("organization creation reservations", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    runInNewTx.mockImplementation(
      (_db: unknown, _orgId: string, work: (tx: unknown) => Promise<unknown>) =>
        work({
          select: () => ({
            from: () => ({
              where: () => ({ limit: () => Promise.resolve([{ id: 1 }]) }),
            }),
          }),
        }) as Promise<never>,
    );
  });

  it("refuses with 409 when the organization id is already reserved", async () => {
    const { deps } = makeDeps(["ORGANIZATION_ID"]);

    await expect(createOrganization(deps, USER, INPUT)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("refuses with 409 when the slug is already taken", async () => {
    const { deps } = makeDeps(["SLUG"]);

    await expect(createOrganization(deps, USER, INPUT)).rejects.toThrow(
      /slug already exists/i,
    );
  });

  it("releases the id it had just reserved when the slug is taken", async () => {
    const { deps, released } = makeDeps(["SLUG"]);

    await expect(createOrganization(deps, USER, INPUT)).rejects.toBeInstanceOf(
      ConflictException,
    );

    // Once from the inner catch, and again from the saga compensation. Both
    // matter: the inner one is what stops a doomed create from parking the id
    // until compensation gets round to it.
    expect(released).toEqual(
      expect.arrayContaining([{ kind: "ORGANIZATION_ID", value: ORG_ID }]),
    );
  });

  it("claims neither reservation when a step fails", async () => {
    const { deps, claimed, wasCompensated } = makeDeps(["SLUG"]);

    await expect(createOrganization(deps, USER, INPUT)).rejects.toBeInstanceOf(
      ConflictException,
    );

    expect(claimed).toEqual([]);
    expect(wasCompensated()).toBe(true);
  });

  it("claims both reservations once every step has committed", async () => {
    const { deps, claimed } = makeDeps([]);

    await expect(createOrganization(deps, USER, INPUT)).resolves.toEqual({
      id: ORG_ID,
      name: INPUT.name,
      slug: INPUT.slug,
    });

    expect(claimed).toEqual([
      { kind: "ORGANIZATION_ID", value: ORG_ID },
      { kind: "SLUG", value: INPUT.slug },
    ]);
  });
});

describe("bootstrapCellOrganization idempotency", () => {
  it("resumes rather than re-inserting when the organizations row already exists", async () => {
    const { deps } = makeDeps([]);
    const insert = jest.fn();

    runInNewTx.mockImplementation(
      (_db: unknown, _orgId: string, work: (tx: unknown) => Promise<unknown>) =>
        work({
          // The organization is already there, which is what a resumed saga
          // sees. Nothing may be written a second time.
          select: () => ({
            from: () => ({
              where: () => ({
                limit: () => Promise.resolve([{ id: ORG_ID }]),
              }),
            }),
          }),
          insert,
          execute: jest.fn(),
        }) as Promise<never>,
    );

    await expect(createOrganization(deps, USER, INPUT)).resolves.toMatchObject({
      id: ORG_ID,
    });

    expect(insert).not.toHaveBeenCalled();
  });
});
