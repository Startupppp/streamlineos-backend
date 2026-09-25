process.env.APP_URL ??= "http://localhost:1000";

jest.mock("../../../common/org/sync-org-unit-placement", () => ({
  syncOrgUnitPlacement: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../../common/hr/sync-canonical-employment-fields", () => ({
  syncCanonicalEmploymentFields: jest.fn().mockResolvedValue(true),
}));

import { ConflictException } from "@nestjs/common";
import { getTableName, type Table } from "drizzle-orm";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { DataScope } from "../../access/access.types";
import { updateEmployeeSchema } from "./dto/hr-directory.schemas";
import {
  EmployeeMutationsService,
  EMAIL_TAKEN_ELSEWHERE_MESSAGE,
  EMAIL_TAKEN_IN_ORG_MESSAGE,
} from "./employee-mutations.service";

/**
 * V-020. There was no way to change an employee's email at all — the update
 * schema is `.strict()` and had no `email` key — so an administrator who typed
 * one wrong had to delete the person and start again, and could not even do
 * that once anything referenced them.
 *
 * `users.email` is a GLOBAL unique index, not a per-tenant one. A check scoped
 * to this organization's members would pass on an address held in another
 * tenant and then 23505 on the UPDATE, so both are refused here — and only the
 * in-tenant case is named, because confirming an address exists somewhere else
 * is an enumeration oracle.
 */

const TARGET = "target-1";
const CURRENT_EMAIL = "old@example.test";

function ctx(): CurrentUserContext {
  return {
    userId: "actor-1",
    orgId: "org-1",
    role: "HR",
    isOrgOwner: false,
    sessionId: "sess-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
  };
}

function buildService(options: {
  /** The account that already holds the requested address, if any. */
  emailHolderId?: string;
  holderIsMember?: boolean;
} = {}) {
  const updated: { table: string; set: Record<string, unknown> }[] = [];
  const tx = {
    update: jest.fn((target: unknown) => ({
      set: jest.fn((set: Record<string, unknown>) => {
        updated.push({ table: getTableName(target as Table), set });
        return { where: jest.fn().mockResolvedValue(undefined) };
      }),
    })),
  };

  let memberLookups = 0;
  const db = {
    query: {
      organizationMembers: {
        // First call is the scope read for the target; any later one is the
        // holder-membership probe.
        findFirst: jest.fn(async () => {
          memberLookups += 1;
          if (memberLookups === 1) return { id: 1, userId: TARGET };
          return options.holderIsMember ? { id: 2 } : undefined;
        }),
      },
      users: {
        findFirst: jest.fn(async (args: { columns?: Record<string, boolean> }) =>
          args.columns?.["firstName"]
            ? {
                firstName: "Target",
                lastName: "Employee",
                name: "Target Employee",
                email: CURRENT_EMAIL,
              }
            : options.emailHolderId
              ? { id: options.emailHolderId }
              : undefined,
        ),
      },
    },
    execute: jest.fn().mockResolvedValue([{ creates_cycle: false }]),
    transaction: jest.fn((callback: (transaction: typeof tx) => unknown) => callback(tx)),
  };

  const service = new EmployeeMutationsService(
    db as never,
    { invalidate: jest.fn(), invalidateNamespace: jest.fn() } as never,
    { logCritical: jest.fn() } as never,
    { emit: jest.fn().mockResolvedValue(undefined) } as never,
    {
      resolveUserPermissions: jest
        .fn()
        .mockResolvedValue(new Map<string, DataScope>([["hr:employees:manage", "all"]])),
    } as never,
    {
      getFacts: jest.fn().mockResolvedValue({
        userId: TARGET,
        employmentId: null,
        employeeNumber: null,
        designation: null,
        joiningDate: null,
        departmentId: null,
        locationId: null,
        managerUserId: null,
      }),
    } as never,
    { assign: jest.fn().mockResolvedValue({ status: "written" }) } as never,
  );

  return { service, updated };
}

describe("the update schema accepts an email", () => {
  it("takes one, lower-cased and trimmed", () => {
    const parsed = updateEmployeeSchema.safeParse({ email: "  Asha.Rao@Example.TEST " });
    expect(parsed.success && parsed.data.email).toBe("asha.rao@example.test");
  });

  it("still refuses something that is not an address", () => {
    expect(updateEmployeeSchema.safeParse({ email: "not-an-address" }).success).toBe(false);
  });
});

describe("EmployeeMutationsService.updateEmployee — changing the address", () => {
  it("rejects an email already used by another member of the same org", async () => {
    const { service, updated } = buildService({
      emailHolderId: "user-other",
      holderIsMember: true,
    });

    await expect(
      service.updateEmployee(ctx(), TARGET, { email: "taken@example.test" }),
    ).rejects.toThrow(new ConflictException(EMAIL_TAKEN_IN_ORG_MESSAGE));
    // Paired with the refusal: nothing was written on the way to it.
    expect(updated).toEqual([]);
  });

  it("rejects an address held outside this org too, without confirming where", async () => {
    // A tenant-scoped check alone would pass this and then 23505 on the global
    // unique index. The message is deliberately vague.
    const { service } = buildService({
      emailHolderId: "user-elsewhere",
      holderIsMember: false,
    });

    await expect(
      service.updateEmployee(ctx(), TARGET, { email: "elsewhere@example.test" }),
    ).rejects.toThrow(new ConflictException(EMAIL_TAKEN_ELSEWHERE_MESSAGE));
  });

  it("updates the email and marks the invite for redelivery", async () => {
    const { service, updated } = buildService();

    await expect(
      service.updateEmployee(ctx(), TARGET, { email: "new@example.test" }),
    ).resolves.toEqual({ success: true });

    expect(updated.find((entry) => entry.table === "users")?.set).toMatchObject({
      email: "new@example.test",
      // Acceptance is derived from email_verified, which means "came through a
      // magic link at THIS address". Carrying it over would badge the person as
      // accepted at a mailbox nobody has proved they hold.
      emailVerified: null,
    });

    // Every live link was mailed to the OLD address, so it is retired and the
    // invite has to be resent — readInviteDelivery keys on the address and
    // already reports "none" for the new one.
    expect(updated.filter((entry) => entry.table === "magic_link_tokens")).toHaveLength(1);
  });

  it("leaves the address and the outstanding links alone when the email is unchanged", async () => {
    const { service, updated } = buildService();

    await service.updateEmployee(ctx(), TARGET, {
      email: CURRENT_EMAIL,
      phone: "+919845098450",
    });

    expect(updated.find((entry) => entry.table === "users")?.set).not.toHaveProperty("email");
    expect(updated.filter((entry) => entry.table === "magic_link_tokens")).toEqual([]);
  });
});
