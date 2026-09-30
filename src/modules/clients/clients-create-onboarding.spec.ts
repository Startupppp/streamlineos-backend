import type { Db } from "../../db/drizzle.module";
import { ClientsService } from "./clients.service";
import { createMirroredClient } from "../party/party-legacy-clients";

jest.mock("../party/party-legacy-clients", () => ({ createMirroredClient: jest.fn() }));

describe("ClientsService.createClient", () => {
  it("starts Client onboarding without activating portal access", async () => {
    jest.mocked(createMirroredClient).mockResolvedValue({ id: 17, name: "Acme" } as never);
    const onboarding = { startForClient: jest.fn().mockResolvedValue(undefined) };
    const service = new ClientsService(
      {} as Db,
      {} as never,
      onboarding as never,
    );

    await expect(service.createClient("org-1", "Acme", { userId: "user-1", membershipId: 41 }))
      .resolves.toEqual({ id: 17, name: "Acme" });

    expect(onboarding.startForClient).toHaveBeenCalledWith(
      "org-1",
      17,
      { userId: "user-1", membershipId: 41 },
    );
  });
});
