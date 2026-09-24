import { ServiceUnavailableException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { NO_TENANT_TRANSACTION } from "../../../common/tenant/no-tenant-transaction.decorator";
import { primeRelocationTrafficTracker } from "../../../common/relocation/relocation-traffic-tracker";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";
import { HrEmailTemplatesController } from "./hr-email-templates.controller";
import { HrEmailTemplatesService } from "./hr-email-templates.service";

const ACTOR = { orgId: "org-email-template", userId: "user-email-template" };

describe("HR email template AI connection hold", () => {
  beforeEach(() => primeRelocationTrafficTracker([], Date.now()));

  it("opts only generateAi out of the request-wide tenant transaction", () => {
    expect(
      Reflect.getMetadata(
        NO_TENANT_TRANSACTION,
        HrEmailTemplatesController.prototype.generateAi,
      ),
    ).toBe(true);

    for (const handler of ["list", "create", "update", "remove"] as const) {
      expect(
        Reflect.getMetadata(
          NO_TENANT_TRANSACTION,
          HrEmailTemplatesController.prototype[handler],
        ),
      ).toBeUndefined();
    }
  });

  it("does not open a database transaction when the provider fails", async () => {
    let transactions = 0;
    const db = {
      transaction: async <T>(run: (tx: unknown) => Promise<T>): Promise<T> => {
        transactions += 1;
        return run(db);
      },
    };
    const gateway = {
      invokeStructured: jest.fn(async () => ({
        ok: false,
        kind: "provider_error",
        message: "provider unavailable",
      })),
    };
    const module = await Test.createTestingModule({
      providers: [
        HrEmailTemplatesService,
        { provide: DRIZZLE, useValue: db },
        { provide: AiGatewayService, useValue: gateway },
      ],
    }).compile();

    await expect(
      module
        .get(HrEmailTemplatesService)
        .generateWithAi(ACTOR.orgId, ACTOR.userId, {
          name: "New starter welcome",
        }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(transactions).toBe(0);
  });

  it("invokes the gateway at depth zero and opens no database transaction", async () => {
    let transactionDepth = 0;
    let transactions = 0;
    let providerDepth: number | undefined;

    const db = {
      transaction: async <T>(run: (tx: unknown) => Promise<T>): Promise<T> => {
        transactions += 1;
        transactionDepth += 1;
        try {
          return await run(db);
        } finally {
          transactionDepth -= 1;
        }
      },
    };
    const gateway = {
      invokeStructured: jest.fn(async () => {
        providerDepth = transactionDepth;
        return {
          ok: true,
          data: { subject: "Welcome", body: "Hello {{employee_name}}" },
        };
      }),
    };
    const module = await Test.createTestingModule({
      providers: [
        HrEmailTemplatesService,
        { provide: DRIZZLE, useValue: db },
        { provide: AiGatewayService, useValue: gateway },
      ],
    }).compile();

    const service = module.get(HrEmailTemplatesService);
    const result = await service.generateWithAi(ACTOR.orgId, ACTOR.userId, {
      name: "New starter welcome",
    });

    expect(result).toEqual({
      subject: "Welcome",
      body: "Hello {{employee_name}}",
    });
    expect(providerDepth).toBe(0);
    expect(transactions).toBe(0);
    expect(transactionDepth).toBe(0);
    expect(gateway.invokeStructured).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: ACTOR,
        charge: true,
      }),
    );
  });
});
