import {
  ACCOUNT_ONLY_PRINCIPAL,
  agentTokenPrincipal,
  humanSessionPrincipal,
  personalTokenPrincipal,
} from "../../common/auth/principal";
import type { Principal } from "../../common/auth/principal";
import { resolvePrincipalScope } from "./access-principal-scope";

describe("resolvePrincipalScope", () => {
  it.each([
    [ACCOUNT_ONLY_PRINCIPAL, "none", 0],
    [humanSessionPrincipal(1, true), "team", 1],
    [personalTokenPrincipal(1, false, "token-1", ["hr:employees:view"]), "team", 1],
    [personalTokenPrincipal(1, false, "token-1", []), "none", 0],
    [agentTokenPrincipal(1, 10, ["hr:employees:view"]), "team", 1],
    [agentTokenPrincipal(1, 10, []), "none", 0],
  ] satisfies [Principal, string, number][])(
    "applies the principal ceiling for %s",
    async (principal, expected, expectedCalls) => {
      const resolveMembership = jest.fn().mockResolvedValue("team");

      await expect(
        resolvePrincipalScope(principal, "hr:employees:view", resolveMembership),
      ).resolves.toBe(expected);
      expect(resolveMembership).toHaveBeenCalledTimes(expectedCalls);
    },
  );

  it("grants a system job only the exact permission in its ceiling", async () => {
    const principal: Principal = {
      kind: "system-job",
      jobId: "outbox-dispatch",
      ceiling: ["notifications:delivery:dispatch"],
    };
    const resolveMembership = jest.fn().mockResolvedValue("all");

    await expect(
      resolvePrincipalScope(
        principal,
        "notifications:delivery:dispatch",
        resolveMembership,
      ),
    ).resolves.toBe("all");
    await expect(
      resolvePrincipalScope(principal, "hr:employees:view", resolveMembership),
    ).resolves.toBe("none");
    expect(resolveMembership).not.toHaveBeenCalled();
  });

  it("never delegates administrative permissions to personal or agent tokens", async () => {
    const permission = "ownership:org:transfer";
    const resolveMembership = jest.fn().mockResolvedValue("all");

    await expect(
      resolvePrincipalScope(
        personalTokenPrincipal(1, true, "token-1", [permission]),
        permission,
        resolveMembership,
      ),
    ).resolves.toBe("none");
    await expect(
      resolvePrincipalScope(
        agentTokenPrincipal(1, 10, [permission]),
        permission,
        resolveMembership,
      ),
    ).resolves.toBe("none");
    expect(resolveMembership).not.toHaveBeenCalled();
  });
});
