import { ForbiddenException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import { ClientsService } from "./clients.service";
import { createMirroredClient } from "../party/party-legacy-clients";

jest.mock("../party/party-legacy-clients", () => ({ createMirroredClient: jest.fn() }));

describe("ClientsService.createClient", () => {
  it("starts Client onboarding without activating portal access", async () => {
    jest.mocked(createMirroredClient).mockResolvedValue({ id: 17, name: "Acme" } as never);
    const onboarding = { startForClient: jest.fn().mockResolvedValue(undefined) };
    const tx = {} as Db;
    const planLimits = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) };
    const service = new ClientsService(
      { transaction: jest.fn((callback) => callback(tx)) } as unknown as Db,
      {} as never,
      onboarding as never,
      planLimits as never,
    );

    await expect(service.createClient("org-1", "Acme", { userId: "user-1", membershipId: 41 }))
      .resolves.toEqual({ id: 17, name: "Acme" });

    expect(onboarding.startForClient).toHaveBeenCalledWith(
      "org-1",
      17,
      { userId: "user-1", membershipId: 41 },
      tx,
    );
    expect(createMirroredClient).toHaveBeenCalledWith(
      tx,
      "org-1",
      { orgId: "org-1", name: "Acme", status: "active" },
      { linkedBy: "user:direct-create" },
    );
    expect(planLimits.assertWithinLimit).toHaveBeenCalledWith("org-1", "crmContacts");
  });

  it("creates no party when the plan refuses the record", async () => {
    jest.mocked(createMirroredClient).mockClear();
    const transaction = jest.fn();
    const service = new ClientsService(
      { transaction } as unknown as Db,
      {} as never,
      { startForClient: jest.fn() } as never,
      { assertWithinLimit: jest.fn().mockRejectedValue(new ForbiddenException("Plan limit reached")) } as never,
    );

    await expect(service.createClient("org-1", "Acme", { userId: "user-1", membershipId: 41 }))
      .rejects.toThrow(ForbiddenException);
    expect(transaction).not.toHaveBeenCalled();
    expect(createMirroredClient).not.toHaveBeenCalled();
  });
});
