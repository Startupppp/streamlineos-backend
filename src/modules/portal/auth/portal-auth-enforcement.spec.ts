import { UnauthorizedException } from "@nestjs/common";
import { SQL, is } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { PortalAuthService } from "./portal-auth.service";
import type { Db } from "../../../db/drizzle.module";
import { PortalTokenService } from "./portal-token.service";
import * as tokenUtil from "../../../common/security/token.util";
import * as withPublicTokenModule from "../../../common/tenant/with-public-token";
import * as withTenantModule from "../../../common/tenant/run-in-tenant-transaction";
import { portalInvitations } from "../../../db/schema";

jest.mock("../../../common/security/token.util");
jest.mock("../../../common/tenant/with-public-token");
jest.mock("../../../common/tenant/run-in-tenant-transaction");

const mockHash = jest.mocked(tokenUtil.hashToken);
const mockWithPublicToken = jest.mocked(withPublicTokenModule.withPublicToken);
const mockRunInTenant = jest.mocked(withTenantModule.runInTenantTransaction);

const mockTokenService = {
  mint: jest.fn().mockResolvedValue({ token: "signed-jwt" }),
} as unknown as PortalTokenService;

const dialect = new PgDialect();
function renderSql(pred: unknown): string {
  if (!is(pred, SQL)) return "";
  return dialect.sqlToQuery(pred).sql;
}

const VALID_INVITATION = {
  portalInvitationId: "inv-1",
  organizationId: "org-1",
  status: "PENDING",
  expiresAt: new Date(Date.now() + 3_600_000),
  partyContactId: "contact-1",
  audience: "CLIENT",
  tokenHash: "hashed-token",
};

function makeDb(): Db {
  return {} as unknown as Db;
}

beforeEach(() => {
  jest.resetAllMocks();
  mockHash.mockReturnValue("hashed-token");
});

describe("PortalAuthService.acceptInvitation — token hashed before lookup (never raw token in DB predicate)", () => {
  it("hashes the raw invitation token before the DB lookup so the plaintext never reaches the database", async () => {
    mockWithPublicToken.mockImplementation(async (_db, _token, fn) => {
      const tx = {
        query: {
          portalInvitations: { findFirst: jest.fn().mockResolvedValue(null) },
        },
      };
      return fn(tx as never);
    });
    const svc = new PortalAuthService(makeDb(), mockTokenService);
    await expect(svc.acceptInvitation("raw-token")).rejects.toThrow(UnauthorizedException);
    expect(mockHash).toHaveBeenCalledWith("raw-token");
  });

  it("passes the hash (not the raw token) to withPublicToken so the SECURITY DEFINER lookup uses the derived hash", async () => {
    mockHash.mockReturnValue("derived-hash-abc");
    mockWithPublicToken.mockImplementation(async (_db, publicTokenArg, fn) => {
      const tx = {
        query: { portalInvitations: { findFirst: jest.fn().mockResolvedValue(null) } },
      };
      await fn(tx as never);
      return null;
    });
    const svc = new PortalAuthService(makeDb(), mockTokenService);
    await expect(svc.acceptInvitation("raw-token")).rejects.toThrow(UnauthorizedException);
    expect(mockWithPublicToken).toHaveBeenCalledWith(
      expect.anything(),
      "derived-hash-abc",
      expect.any(Function),
    );
  });
});

describe("PortalAuthService.acceptInvitation — WHERE predicate enforces status=PENDING and expiresAt>now", () => {
  it("the findFirst WHERE predicate contains 'status' so only PENDING invitations are loaded, not ACCEPTED/REVOKED ones", async () => {
    let capturedWhere: unknown = null;
    mockWithPublicToken.mockImplementation(async (_db, _token, fn) => {
      const tx = {
        query: {
          portalInvitations: {
            findFirst: jest.fn().mockImplementation(({ where }: { where: unknown }) => {
              capturedWhere = where;
              return Promise.resolve(null);
            }),
          },
        },
      };
      return fn(tx as never);
    });
    const svc = new PortalAuthService(makeDb(), mockTokenService);
    await expect(svc.acceptInvitation("raw-token")).rejects.toThrow(UnauthorizedException);
    const sql = renderSql(capturedWhere);
    expect(sql).toContain("status");
  });

  it("the findFirst WHERE predicate contains 'expires_at' so expired invitations are excluded by the database, not application code", async () => {
    let capturedWhere: unknown = null;
    mockWithPublicToken.mockImplementation(async (_db, _token, fn) => {
      const tx = {
        query: {
          portalInvitations: {
            findFirst: jest.fn().mockImplementation(({ where }: { where: unknown }) => {
              capturedWhere = where;
              return Promise.resolve(null);
            }),
          },
        },
      };
      return fn(tx as never);
    });
    const svc = new PortalAuthService(makeDb(), mockTokenService);
    await expect(svc.acceptInvitation("raw-token")).rejects.toThrow(UnauthorizedException);
    const sql = renderSql(capturedWhere);
    expect(sql).toContain("expires_at");
  });

  it("the findFirst WHERE predicate contains the token hash so lookup is scoped to a specific invitation, not all PENDING ones", async () => {
    let capturedWhere: unknown = null;
    mockHash.mockReturnValue("my-token-hash-xyz");
    mockWithPublicToken.mockImplementation(async (_db, _token, fn) => {
      const tx = {
        query: {
          portalInvitations: {
            findFirst: jest.fn().mockImplementation(({ where }: { where: unknown }) => {
              capturedWhere = where;
              return Promise.resolve(null);
            }),
          },
        },
      };
      return fn(tx as never);
    });
    const svc = new PortalAuthService(makeDb(), mockTokenService);
    await expect(svc.acceptInvitation("raw-token")).rejects.toThrow(UnauthorizedException);
    const query = dialect.sqlToQuery(capturedWhere as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(query.params).toContain("my-token-hash-xyz");
  });
});

describe("PortalAuthService.acceptInvitation — rejection when no matching invitation (lifecycle + expiry enforcement positive result)", () => {
  it("throws generic UnauthorizedException when DB returns null — the generic message prevents information leakage", async () => {
    mockWithPublicToken.mockImplementation(async (_db, _token, fn) => {
      const tx = { query: { portalInvitations: { findFirst: jest.fn().mockResolvedValue(null) } } };
      return fn(tx as never);
    });
    const svc = new PortalAuthService(makeDb(), mockTokenService);
    await expect(svc.acceptInvitation("raw-token")).rejects.toThrow(UnauthorizedException);
    expect(mockRunInTenant).not.toHaveBeenCalled();
  });

  it("does NOT proceed to the tenant transaction when the invitation lookup returns nothing — short-circuits before writing", async () => {
    mockWithPublicToken.mockImplementation(async (_db, _token, fn) => {
      const tx = { query: { portalInvitations: { findFirst: jest.fn().mockResolvedValue(null) } } };
      return fn(tx as never);
    });
    const svc = new PortalAuthService(makeDb(), mockTokenService);
    await expect(svc.acceptInvitation("raw-token")).rejects.toThrow(UnauthorizedException);
    expect(mockRunInTenant).not.toHaveBeenCalled();
    expect(mockTokenService.mint).not.toHaveBeenCalled();
  });
});

describe("PortalAuthService.acceptInvitation — transactional invitation claim", () => {
  it("revalidates token, tenant, PENDING status, and expiry before any membership write", async () => {
    mockWithPublicToken.mockImplementation(async (_db, _token, fn) => {
      const tx = {
        query: {
          portalInvitations: { findFirst: jest.fn().mockResolvedValue(VALID_INVITATION) },
        },
      };
      return fn(tx as never);
    });

    let claimWhere: unknown;
    const select = jest.fn();
    const insert = jest.fn();
    mockRunInTenant.mockImplementation(async (_db, fn) => {
      const tx = {
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({
            where: jest.fn().mockImplementation((where: unknown) => {
              claimWhere = where;
              return { returning: jest.fn().mockResolvedValue([]) };
            }),
          }),
        }),
        select,
        insert,
      };
      return (fn as (tx: unknown) => Promise<unknown>)(tx);
    });

    const svc = new PortalAuthService(makeDb(), mockTokenService);
    await expect(svc.acceptInvitation("raw-token")).rejects.toThrow(
      "Invalid or expired invitation token",
    );

    const query = dialect.sqlToQuery(claimWhere as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(query.sql).toContain("portal_invitation_id");
    expect(query.sql).toContain("organization_id");
    expect(query.sql).toContain("token_hash");
    expect(query.sql).toContain("status");
    expect(query.sql).toContain("expires_at");
    expect(query.params).toEqual(
      expect.arrayContaining(["inv-1", "org-1", "hashed-token", "PENDING"]),
    );
    expect(select).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    expect(mockTokenService.mint).not.toHaveBeenCalled();
  });

  it("allows only one concurrent or replayed acceptance to create a membership and mint a session", async () => {
    mockWithPublicToken.mockImplementation(async (_db, _token, fn) => {
      const tx = {
        query: {
          portalInvitations: { findFirst: jest.fn().mockResolvedValue(VALID_INVITATION) },
        },
      };
      return fn(tx as never);
    });

    let claimed = false;
    const inserts: unknown[] = [];
    mockRunInTenant.mockImplementation(async (_db, fn) => {
      let invitationUpdateCount = 0;
      const tx = {
        update: jest.fn().mockImplementation((table) => {
          if (table === portalInvitations && invitationUpdateCount++ === 0) {
            const rows = claimed ? [] : [VALID_INVITATION];
            claimed = true;
            return {
              set: jest.fn().mockReturnValue({
                where: jest.fn().mockReturnValue({
                  returning: jest.fn().mockResolvedValue(rows),
                }),
              }),
            };
          }
          return {
            set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
          };
        }),
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          limit: jest.fn().mockResolvedValue([]),
        }),
        insert: jest.fn().mockImplementation((table) => {
          inserts.push(table);
          return {
            values: jest.fn().mockReturnValue({
              returning: jest
                .fn()
                .mockResolvedValue([{ portalMembershipId: "mem-new", sessionEpoch: 0 }]),
            }),
          };
        }),
      };
      return (fn as (tx: unknown) => Promise<unknown>)(tx);
    });
    (mockTokenService.mint as jest.Mock).mockResolvedValue({ token: "minted-jwt" });

    const svc = new PortalAuthService(makeDb(), mockTokenService);
    const results = await Promise.allSettled([
      svc.acceptInvitation("raw-token"),
      svc.acceptInvitation("raw-token"),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(inserts).toHaveLength(1);
    expect(mockTokenService.mint).toHaveBeenCalledTimes(1);
  });
});

describe("PortalAuthService.acceptInvitation — suspended membership gate", () => {
  it("throws UnauthorizedException when the existing portal membership is SUSPENDED — suspended users cannot re-enter", async () => {
    mockWithPublicToken.mockImplementation(async (_db, _token, fn) => {
      const tx = { query: { portalInvitations: { findFirst: jest.fn().mockResolvedValue(VALID_INVITATION) } } };
      return fn(tx as never);
    });
    const suspendedMembership = {
      portalMembershipId: "mem-1",
      status: "SUSPENDED",
      organizationId: "org-1",
    };
    mockRunInTenant.mockImplementation(async (_db, fn) => {
      const claimReturning = jest.fn().mockResolvedValue([VALID_INVITATION]);
      const claimWhere = jest.fn().mockReturnValue({ returning: claimReturning });
      const claimSet = jest.fn().mockReturnValue({ where: claimWhere });
      const selectChain = {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([suspendedMembership]),
      };
      const tx = {
        select: jest.fn().mockReturnValue(selectChain),
        update: jest.fn().mockReturnValue({ set: claimSet }),
        insert: jest.fn(),
      };
      return (fn as (tx: unknown) => Promise<unknown>)(tx);
    });
    const svc = new PortalAuthService(makeDb(), mockTokenService);
    await expect(svc.acceptInvitation("raw-token")).rejects.toThrow(UnauthorizedException);
    expect(mockTokenService.mint).not.toHaveBeenCalled();
  });
});

describe("PortalAuthService.acceptInvitation — tenant scope gate", () => {
  it("calls runInTenantTransaction with the invitation's organizationId, not a client-controlled value", async () => {
    mockWithPublicToken.mockImplementation(async (_db, _token, fn) => {
      const tx = {
        query: {
          portalInvitations: { findFirst: jest.fn().mockResolvedValue(VALID_INVITATION) },
        },
      };
      return fn(tx as never);
    });
    mockRunInTenant.mockImplementation(async (_db, fn, opts) => {
      expect((opts as { orgId: string }).orgId).toBe("org-1");
      expect((opts as { audience: string }).audience).toBe("PORTAL");
      let invitationUpdateCount = 0;
      const tx = {
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          limit: jest.fn().mockResolvedValue([]),
        }),
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([{ portalMembershipId: "mem-new", sessionEpoch: 0 }]),
          }),
        }),
        update: jest.fn().mockImplementation((table) => {
          if (table === portalInvitations && invitationUpdateCount++ === 0) {
            return {
              set: jest.fn().mockReturnValue({
                where: jest.fn().mockReturnValue({
                  returning: jest.fn().mockResolvedValue([VALID_INVITATION]),
                }),
              }),
            };
          }
          return {
            set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
          };
        }),
        execute: jest.fn().mockResolvedValue(undefined),
      };
      (mockTokenService.mint as jest.Mock).mockResolvedValue({ token: "minted-jwt" });
      return (fn as (tx: unknown) => Promise<unknown>)(tx);
    });
    const svc = new PortalAuthService(makeDb(), mockTokenService);
    const result = await svc.acceptInvitation("raw-token");
    expect(result).toEqual({ token: "minted-jwt" });
  });
});
