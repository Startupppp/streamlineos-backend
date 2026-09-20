import { serializeDirective, stripDirectives, type AskOsDirective } from "./ask-os-directive";

const CONFIRM: Extract<AskOsDirective, { kind: "confirm-action" }> = {
  kind: "confirm-action",
  proposalId: 42,
  token: "eyJhbGciOi.redeemable-hmac-token.signature",
  action: "hr.grantBonus",
  summary: "Grant a bonus of 5,000 to Priya Raman",
  preview: { amount: 5000, recipient: "Priya Raman" },
  expiresAt: "2026-09-20T12:00:00.000Z",
  title: "Grant bonus",
  confirmLabel: "Grant",
};

function serializedBody(directive: AskOsDirective): Record<string, unknown> {
  const line = serializeDirective(directive);
  const json = line.slice(line.indexOf(":") + 1);
  const parsed: unknown = JSON.parse(json);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("serialized directive is not an object");
  return parsed as Record<string, unknown>;
}

describe("the serialized directive is what gets written into chat history, so it must not carry a redeemable token", () => {
  it("omits the confirmation token, because every history read returns this string to the client", () => {
    expect(serializedBody(CONFIRM)).not.toHaveProperty("token");
  });

  it("does not leak the token anywhere in the serialized line, including inside preview", () => {
    expect(serializeDirective(CONFIRM)).not.toContain(CONFIRM.token);
  });

  it("still carries everything the read-only card renders, so dropping the token does not blank the replayed turn", () => {
    expect(serializedBody(CONFIRM)).toEqual({
      proposalId: 42,
      action: "hr.grantBonus",
      summary: "Grant a bonus of 5,000 to Priya Raman",
      preview: { amount: 5000, recipient: "Priya Raman" },
      expiresAt: "2026-09-20T12:00:00.000Z",
      title: "Grant bonus",
      confirmLabel: "Grant",
    });
  });

  it("(anti-vacuous) the fixture really does carry a token, so the assertions above are not passing on an empty field", () => {
    expect(CONFIRM.token.length).toBeGreaterThan(0);
  });

  it("leaves a connect-integration directive intact, because it holds nothing redeemable", () => {
    expect(
      serializedBody({
        kind: "connect-integration",
        toolkit: "gmail",
        reason: "no-connection",
        summary: "Connect a mail account.",
      }),
    ).toEqual({ toolkit: "gmail", reason: "no-connection", summary: "Connect a mail account." });
  });

  it("is removed wholesale from the text the model sees, so the model never reads a proposal id either", () => {
    const stored = `Here is what I will do.\n${serializeDirective(CONFIRM)}`;

    expect(stripDirectives(stored)).toBe("Here is what I will do.");
  });
});
