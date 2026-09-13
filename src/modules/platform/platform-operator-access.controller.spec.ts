import { UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { BODYLESS_ACTION } from "../../common/openapi/zod-operation-contracts";
import { createGrantSchema, listGrantsQuerySchema, revokeGrantSchema } from "./dto/platform.schemas";
import { PlatformOperatorAccessController } from "./platform-operator-access.controller";
import type { PlatformOperatorAccessService } from "./platform-operator-access.service";

const PLATFORM_ADMIN_IDS = "requester-admin,approver-admin,platform-op";

function operator(
  userId: string,
  kind: "human-session" | "service-api-key" = "human-session",
): CurrentUserContext {
  return {
    userId,
    orgId: "platform-org",
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "session-1",
    tokenScopes: null,
    principal: {
      kind,
      membershipId: 1,
      isOrgOwner: false,
    },
  } as CurrentUserContext;
}

function httpRequest(): Request {
  return {
    headers: { "x-forwarded-for": "203.0.113.99" },
    ip: "10.0.0.7",
  } as unknown as Request;
}

describe("PlatformOperatorAccessController identity integrity", () => {
  const createGrantAndLog = jest.fn();
  const approveGrant = jest.fn();
  const recordAccess = jest.fn();
  const service = { createGrantAndLog, approveGrant, recordAccess } as unknown as PlatformOperatorAccessService;
  const controller = new PlatformOperatorAccessController(service, {
    INTERNAL_API_SECRET: "test-internal-secret",
  });

  beforeAll(() => {
    process.env.PLATFORM_ADMIN_USER_IDS = PLATFORM_ADMIN_IDS;
  });

  afterAll(() => {
    delete process.env.PLATFORM_ADMIN_USER_IDS;
  });

  beforeEach(() => {
    createGrantAndLog.mockReset().mockResolvedValue("grant-1");
    approveGrant.mockReset().mockResolvedValue({ orgId: "customer-org", operatorUserId: "support-op" });
    recordAccess.mockReset().mockResolvedValue(undefined);
  });

  it("declares grant approval as a bodyless OpenAPI action", () => {
    expect(
      Reflect.getMetadata(
        BODYLESS_ACTION,
        PlatformOperatorAccessController.prototype.approveGrant,
      ),
    ).toBe(true);
  });

  it("rejects a client-supplied requester identity at the validation boundary", () => {
    expect(createGrantSchema.safeParse({
      operatorUserId: "support-op",
      orgId: "customer-org",
      incidentRef: "INC-1",
      grantedBy: "spoofed-admin",
      scope: "read_customer_data",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }).success).toBe(false);
  });

  it("accepts revoked grants in the management-plane list filter", () => {
    expect(listGrantsQuerySchema.safeParse({ orgId: "customer-org", status: "revoked" }).success).toBe(true);
  });

  it("(bite proof) revoke reason min-3 enforced at schema boundary", () => {
    expect(revokeGrantSchema.safeParse({ reason: "yes" }).success).toBe(true);
    expect(revokeGrantSchema.safeParse({ reason: "ab" }).success).toBe(false);
    expect(revokeGrantSchema.safeParse({ reason: "  x  " }).success).toBe(false);
  });

  it("derives grantedBy from the authenticated human and ignores forwarded audit IP headers", async () => {
    await controller.createGrant(
      "test-internal-secret",
      {
        operatorUserId: "support-op",
        orgId: "customer-org",
        incidentRef: "INC-1",
        reason: "Investigate customer incident",
        scope: "read_customer_data",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      operator("requester-admin"),
      httpRequest(),
    );

    expect(createGrantAndLog).toHaveBeenCalledWith(
      expect.objectContaining({ grantedBy: "requester-admin" }),
      "10.0.0.7",
      expect.objectContaining({ requestedBy: "requester-admin" }),
    );
  });

  it("derives approverId from a second authenticated human", async () => {
    await controller.approveGrant(
      "test-internal-secret",
      "grant-1",
      operator("approver-admin"),
      httpRequest(),
    );

    expect(approveGrant).toHaveBeenCalledWith("grant-1", "approver-admin", "10.0.0.7");
    expect(recordAccess).not.toHaveBeenCalled();
  });

  it.each(["create", "approve"] as const)("rejects a service principal on %s", async (operation) => {
    const serviceUser = operator("platform-op", "service-api-key");
    const attempt = operation === "create"
      ? controller.createGrant(
          "test-internal-secret",
          {
            operatorUserId: "support-op",
            orgId: "customer-org",
            incidentRef: "INC-1",
            reason: "Investigate customer incident",
            scope: "read_customer_data",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
          serviceUser,
          httpRequest(),
        )
      : controller.approveGrant("test-internal-secret", "grant-1", serviceUser, httpRequest());

    await expect(attempt).rejects.toBeInstanceOf(UnauthorizedException);
    expect(createGrantAndLog).not.toHaveBeenCalled();
    expect(approveGrant).not.toHaveBeenCalled();
  });

  it("(bite proof) rejects a human session whose userId is not in PLATFORM_ADMIN_USER_IDS", async () => {
    await expect(
      controller.createGrant(
        "test-internal-secret",
        {
          operatorUserId: "support-op",
          orgId: "customer-org",
          incidentRef: "INC-1",
          reason: "Investigate customer incident",
          scope: "read_customer_data",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        operator("tenant-org-admin"),
        httpRequest(),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(createGrantAndLog).not.toHaveBeenCalled();
  });

  it("(bite proof) org owner who is not a platform admin is denied — tenant-level standing does not confer platform access", async () => {
    const tenantOwner: CurrentUserContext = {
      ...operator("tenant-owner"),
      isOrgOwner: true,
      role: "OWNER",
    };
    await expect(
      controller.createGrant(
        "test-internal-secret",
        {
          operatorUserId: "support-op",
          orgId: "customer-org",
          incidentRef: "INC-1",
          reason: "Investigate customer incident",
          scope: "read_customer_data",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        tenantOwner,
        httpRequest(),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(createGrantAndLog).not.toHaveBeenCalled();
  });

  it("wrong internal secret is refused regardless of platform admin standing", async () => {
    await expect(
      controller.createGrant(
        "wrong-secret",
        {
          operatorUserId: "support-op",
          orgId: "customer-org",
          incidentRef: "INC-1",
          reason: "Investigate customer incident",
          scope: "read_customer_data",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        operator("requester-admin"),
        httpRequest(),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(createGrantAndLog).not.toHaveBeenCalled();
  });
});
