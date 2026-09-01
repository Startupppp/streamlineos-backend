import { ForbiddenException, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { NextFunction, Request, Response } from "express";
import request from "supertest";
import { OperatorSessionGuard } from "./operator-session.guard";
import { PlatformOperatorAccessService } from "./platform-operator-access.service";
import { PlatformOperatorCustomerController } from "./platform-operator-customer.controller";
import { PlatformOperatorCustomerService } from "./platform-operator-customer.service";

describe("PlatformOperatorCustomerController grant integration", () => {
  let app: INestApplication;
  let principalKind: "human-session" | "service-api-key";

  const authorizeRequest = jest.fn<Promise<void>, unknown[]>();
  const getCustomer = jest.fn();
  const getBilling = jest.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PlatformOperatorCustomerController],
      providers: [
        OperatorSessionGuard,
        {
          provide: PlatformOperatorAccessService,
          useValue: { authorizeRequest },
        },
        {
          provide: PlatformOperatorCustomerService,
          useValue: { getCustomer, getBilling },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use((req: Request & { user?: unknown }, _res: Response, next: NextFunction) => {
      req.user = {
        userId: "operator-1",
        orgId: "operator-home-org",
        role: "MEMBER",
        isOrgOwner: false,
        sessionId: "session-1",
        tokenScopes: null,
        principal: {
          kind: principalKind,
          membershipId: 1,
          isOrgOwner: false,
        },
      };
      next();
    });
    await app.init();
  });

  beforeEach(() => {
    principalKind = "human-session";
    authorizeRequest.mockReset().mockResolvedValue(undefined);
    getCustomer.mockReset().mockResolvedValue({ organization: { id: "customer-org" }, members: [] });
    getBilling.mockReset().mockResolvedValue({ subscription: null, payments: [] });
  });

  afterAll(async () => app.close());

  it("requires a human operator session", async () => {
    principalKind = "service-api-key";

    await request(app.getHttpServer())
      .get("/platform/operator/organizations/customer-org")
      .expect(401);

    expect(authorizeRequest).not.toHaveBeenCalled();
    expect(getCustomer).not.toHaveBeenCalled();
  });

  it("authorizes and audits the organization-specific customer-data scope", async () => {
    await request(app.getHttpServer())
      .get("/platform/operator/organizations/customer-org")
      .expect(200);

    expect(authorizeRequest).toHaveBeenCalledWith(
      "operator-1",
      "customer-org",
      "read_customer_data",
      expect.stringContaining("operator.get."),
      expect.anything(),
    );
    expect(getCustomer).toHaveBeenCalledWith("customer-org");
  });

  it("uses the separate payments scope for billing data", async () => {
    await request(app.getHttpServer())
      .get("/platform/operator/organizations/customer-org/billing")
      .expect(200);

    expect(authorizeRequest).toHaveBeenCalledWith(
      "operator-1",
      "customer-org",
      "read_payments",
      expect.stringContaining("operator.get."),
      expect.anything(),
    );
    expect(getBilling).toHaveBeenCalledWith("customer-org");
  });

  it.each(["expired", "revoked", "wrong-org"])(
    "does not enter the customer service when the grant is %s",
    async () => {
      authorizeRequest.mockRejectedValueOnce(
        new ForbiddenException("No active operator access grant for this organisation and scope"),
      );

      await request(app.getHttpServer())
        .get("/platform/operator/organizations/customer-org")
        .expect(403);

      expect(getCustomer).not.toHaveBeenCalled();
    },
  );
});
