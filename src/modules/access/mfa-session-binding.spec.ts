import type { Db } from "../../db/drizzle.module";
import type { CacheService } from "../../common/cache/cache.service";
import { stubService } from "../../test/service-stub.spec-fixtures";
import {
  mfaSessionRefFor,
  type MfaSessionRef,
} from "../../common/auth/mfa-policy.token";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import {
  agentTokenPrincipal,
  humanSessionPrincipal,
  personalTokenPrincipal,
  systemJobPrincipal,
  ACCOUNT_ONLY_PRINCIPAL,
} from "../../common/auth/principal";
import { MfaPolicyService } from "./mfa-policy.service";

const ORG = "org-1";
const USER = "user-1";
const SESSION = "session-1";

const HUMAN: MfaSessionRef = { sessionId: SESSION, interactive: true };
const MACHINE: MfaSessionRef = { sessionId: SESSION, interactive: false };

function makeDb(opts: {
  mfaEnforced: boolean;
  totpEnabled: boolean;
  mfaSatisfiedAt: Date | null;
  sessionExists?: boolean;
}): Db {
  const session =
    opts.sessionExists === false
      ? null
      : { mfaSatisfiedAt: opts.mfaSatisfiedAt };
  return {
    query: {
      organizations: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ mfaEnforced: opts.mfaEnforced }),
      },
      users: {
        findFirst: jest.fn().mockResolvedValue({
          totpEnabled: opts.totpEnabled,
        }),
      },
      userSessions: { findFirst: jest.fn().mockResolvedValue(session) },
    },
  } as unknown as Db;
}

function makeCache(): CacheService {
  return stubService<CacheService>({
    cachedForOrg: jest
      .fn()
      .mockImplementation(
        (_orgId: unknown, _key: unknown, fn: () => Promise<unknown>) => fn(),
      ),
    cached: jest
      .fn()
      .mockImplementation((_k: unknown, fn: () => Promise<unknown>) => fn()),
    invalidateForOrg: jest.fn(),
    invalidate: jest.fn(),
  });
}

describe("MFA is satisfied by a challenged session, not by enrolment", () => {
  it("denies an enrolled user whose session never passed a challenge, because totp_enabled records enrolment and not authentication", async () => {
    const db = makeDb({
      mfaEnforced: true,
      totpEnabled: true,
      mfaSatisfiedAt: null,
    });
    const service = new MfaPolicyService(db, makeCache());

    await expect(service.resolve(ORG, USER, HUMAN)).resolves.toEqual({
      enforced: true,
      satisfied: false,
    });
  });

  it("allows an enrolled user whose session carries mfa_satisfied_at", async () => {
    const db = makeDb({
      mfaEnforced: true,
      totpEnabled: true,
      mfaSatisfiedAt: new Date("2026-09-30T00:00:00Z"),
    });
    const service = new MfaPolicyService(db, makeCache());

    await expect(service.resolve(ORG, USER, HUMAN)).resolves.toEqual({
      enforced: true,
      satisfied: true,
    });
  });

  it("denies a session id that resolves to no session row, so a forged or expired id cannot pass", async () => {
    const db = makeDb({
      mfaEnforced: true,
      totpEnabled: true,
      mfaSatisfiedAt: null,
      sessionExists: false,
    });
    const service = new MfaPolicyService(db, makeCache());

    await expect(service.resolve(ORG, USER, HUMAN)).resolves.toEqual({
      enforced: true,
      satisfied: false,
    });
  });

  it("denies an enforcing org's user who has not enrolled at all", async () => {
    const db = makeDb({
      mfaEnforced: true,
      totpEnabled: false,
      mfaSatisfiedAt: null,
    });
    const service = new MfaPolicyService(db, makeCache());

    await expect(service.resolve(ORG, USER, HUMAN)).resolves.toEqual({
      enforced: true,
      satisfied: false,
    });
  });

  it("satisfies a machine principal from enrolment, because no bearer token can answer an interactive TOTP challenge", async () => {
    const db = makeDb({
      mfaEnforced: true,
      totpEnabled: true,
      mfaSatisfiedAt: null,
    });
    const service = new MfaPolicyService(db, makeCache());

    await expect(service.resolve(ORG, USER, MACHINE)).resolves.toEqual({
      enforced: true,
      satisfied: true,
    });
  });

  it("never reads the session when the org does not enforce MFA, so non-enforcing tenants pay no extra query", async () => {
    const db = makeDb({
      mfaEnforced: false,
      totpEnabled: true,
      mfaSatisfiedAt: null,
    });
    const service = new MfaPolicyService(db, makeCache());

    await expect(service.resolve(ORG, USER, HUMAN)).resolves.toEqual({
      enforced: false,
      satisfied: true,
    });
    expect(db.query.userSessions.findFirst).not.toHaveBeenCalled();
  });
});

describe("mfaSessionRefFor marks only human principals interactive", () => {
  function actor(principal: CurrentUserContext["principal"]): CurrentUserContext {
    return {
      userId: USER,
      orgId: ORG,
      role: "member",
      isOrgOwner: false,
      sessionId: SESSION,
      tokenScopes: null,
      principal,
    };
  }

  it("treats a human session as interactive", () => {
    expect(mfaSessionRefFor(actor(humanSessionPrincipal(1, false)))).toEqual({
      sessionId: SESSION,
      interactive: true,
    });
  });

  it("treats an account-only principal as interactive, because it is still a person at a browser", () => {
    expect(
      mfaSessionRefFor(actor(ACCOUNT_ONLY_PRINCIPAL)).interactive,
    ).toBe(true);
  });

  it("treats a personal token as non-interactive", () => {
    expect(
      mfaSessionRefFor(actor(personalTokenPrincipal(1, false, "t1", [])))
        .interactive,
    ).toBe(false);
  });

  it("treats an agent token as non-interactive", () => {
    expect(
      mfaSessionRefFor(actor(agentTokenPrincipal(1, 2, []))).interactive,
    ).toBe(false);
  });

  it("treats a system job as non-interactive", () => {
    expect(
      mfaSessionRefFor(actor(systemJobPrincipal("build.daily-snapshots")))
        .interactive,
    ).toBe(false);
  });
});
