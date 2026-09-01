import { UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { BODYLESS_ACTION } from "../../common/openapi/zod-operation-contracts";
import { createGrantSchema, listGrantsQuerySchema } from "./dto/platform.schemas";
import { PlatformOperatorAccessController } from "./platform-operator-access.controller";
import type { PlatformOperatorAccessService } from "./platform-operator-access.service";

function operator(
  userId: string,
  kind: "human-session" | "service-api-key" = "human-session",
  role = "ADMIN",
): CurrentUserContext {
  return {
    userId,
    orgId: "platform-org",
    role,
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

  it("derives grantedBy from the authenticated human and ignores forwarded audit IP headers", async () => {
    await controller.createGrant(
      "test-internal-secret",
      {
        operatorUserId: "support-op",
        orgId: "customer-org",
        incidentRef: "INC-1",
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

    expect(approveGrant).toHaveBeenCalledWith("grant-1", "approver-admin");
    expect(recordAccess).toHaveBeenCalledWith(
      "grant-1",
      "approver-admin",
      "customer-org",
      "grant.approved",
      "10.0.0.7",
      { operatorUserId: "support-op" },
    );
  });

  it.each(["create", "approve"] as const)("rejects a service principal on %s", async (operation) => {
    const serviceUser = operator("automation", "service-api-key");
    const attempt = operation === "create"
      ? controller.createGrant(
          "test-internal-secret",
          {
            operatorUserId: "support-op",
            orgId: "customer-org",
            incidentRef: "INC-1",
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

  it("rejects a human session without an eligible admin role", async () => {
    await expect(
      controller.createGrant(
        "test-internal-secret",
        {
          operatorUserId: "support-op",
          orgId: "customer-org",
          incidentRef: "INC-1",
          scope: "read_customer_data",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        operator("ordinary-member", "human-session", "MEMBER"),
        httpRequest(),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(createGrantAndLog).not.toHaveBeenCalled();
  });
});
