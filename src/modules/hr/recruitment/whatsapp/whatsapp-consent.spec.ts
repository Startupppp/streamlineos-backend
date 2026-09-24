import {
  decideSend,
  phoneMatchKey,
  renderTemplate,
  SEND_REFUSAL_COPY,
  WHATSAPP_TEMPLATE_KEYS,
  WHATSAPP_TEMPLATES,
} from "./whatsapp-consent";
import { resolveWhatsapp, WHATSAPP_ADAPTERS } from "./whatsapp.service";

const EARLY = new Date("2026-01-01T00:00:00.000Z");
const LATE = new Date("2026-06-01T00:00:00.000Z");

describe("decideSend", () => {
  it("allows a candidate who opted in and never withdrew", () => {
    expect(decideSend({ optInAt: EARLY, optOutAt: null })).toEqual({ allowed: true });
  });

  /**
   * Absence is not permission. This is the whole gate: a candidate nobody has
   * asked must not be messageable because nothing says no.
   */
  it("refuses a candidate who was never asked", () => {
    expect(decideSend({ optInAt: null, optOutAt: null })).toEqual({
      allowed: false,
      reason: "never-opted-in",
    });
  });

  it("refuses a candidate who opted out without ever opting in", () => {
    expect(decideSend({ optInAt: null, optOutAt: EARLY })).toMatchObject({
      reason: "opted-out",
    });
  });

  it("refuses when the withdrawal came after the opt-in", () => {
    expect(decideSend({ optInAt: EARLY, optOutAt: LATE })).toMatchObject({
      reason: "opt-out-after-opt-in",
    });
  });

  /**
   * Re-consenting works, and it works by order rather than by clearing the
   * withdrawal — which is what keeps both timestamps as evidence.
   */
  it("allows again when a later opt-in follows a withdrawal", () => {
    expect(decideSend({ optInAt: LATE, optOutAt: EARLY })).toEqual({ allowed: true });
  });

  /** A same-instant tie goes to the withdrawal. Refusing is the safe direction. */
  it("refuses when both happened at the same instant", () => {
    expect(decideSend({ optInAt: EARLY, optOutAt: EARLY })).toMatchObject({ allowed: false });
  });

  /**
   * Two refusals, two different situations: one candidate may still be asked,
   * the other may not. One shared message would invite somebody to go and ask
   * again.
   */
  it("gives a distinct sentence for each refusal", () => {
    const reasons = Object.keys(SEND_REFUSAL_COPY);
    const copies = Object.values(SEND_REFUSAL_COPY);
    expect(new Set(copies).size).toBe(reasons.length);
  });
});

describe("renderTemplate", () => {
  it("fills every declared variable", () => {
    const result = renderTemplate("interview_reminder", {
      candidateName: "Jane",
      when: "Tuesday 3pm",
    });
    expect(result).toEqual({ ok: true, body: "Hi Jane, a reminder about your interview at Tuesday 3pm." });
  });

  /**
   * "Hi {{candidateName}}" arriving on somebody's phone is worse than no
   * message, and the failure is silent unless the renderer checks.
   */
  it("refuses rather than leaving a placeholder behind", () => {
    const result = renderTemplate("interview_reminder", { candidateName: "Jane" });
    expect(result).toEqual({ ok: false, missing: ["when"] });
  });

  it("treats a blank value as missing", () => {
    const result = renderTemplate("interview_reminder", { candidateName: "Jane", when: "   " });
    expect(result).toMatchObject({ ok: false, missing: ["when"] });
  });

  it("ignores variables the template never declared", () => {
    const result = renderTemplate("interview_reminder", {
      candidateName: "Jane",
      when: "Tuesday",
      salary: "12 lakh",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected a render");
    expect(result.body).not.toContain("12 lakh");
  });

  it("has a renderable body for every template in the catalog", () => {
    for (const key of WHATSAPP_TEMPLATE_KEYS) {
      const variables = Object.fromEntries(
        WHATSAPP_TEMPLATES[key].variables.map((name) => [name, "x"]),
      );
      expect(renderTemplate(key, variables).ok).toBe(true);
    }
  });

  it("leaves no placeholder in any rendered body", () => {
    for (const key of WHATSAPP_TEMPLATE_KEYS) {
      const variables = Object.fromEntries(
        WHATSAPP_TEMPLATES[key].variables.map((name) => [name, "filled"]),
      );
      const result = renderTemplate(key, variables);
      if (!result.ok) throw new Error(`template ${key} did not render`);
      expect(result.body).not.toContain("{{");
    }
  });
});

describe("phoneMatchKey", () => {
  /**
   * The same Indian number is stored four ways and arrives from WhatsApp a
   * fifth. Matching on the last ten digits is what makes them comparable.
   */
  it.each([
    "919876543210",
    "+91 98765 43210",
    "09876543210",
    "9876543210",
    "+91-98765-43210",
  ])("reduces %s to the same key", (raw) => {
    expect(phoneMatchKey(raw)).toBe("9876543210");
  });

  it("refuses anything too short to identify anybody", () => {
    expect(phoneMatchKey("12345")).toBeNull();
    expect(phoneMatchKey("")).toBeNull();
    expect(phoneMatchKey("not a phone")).toBeNull();
  });
});

describe("the WhatsApp provider", () => {
  /**
   * The most tempting stub in this lane — the API is simple and a fake send
   * costs nothing — and the most damaging, because "sent" against a candidate
   * looks identical whether or not their phone ever rang.
   */
  it("ships no adapter", () => {
    expect(WHATSAPP_ADAPTERS.size).toBe(0);
  });

  it("blocks with no-integration when nothing is connected", () => {
    expect(resolveWhatsapp(null)).toMatchObject({
      status: "BLOCKED",
      code: "no-integration",
    });
  });

  it("blocks as not-implemented with credentials saved, and names the fallback", () => {
    const resolved = resolveWhatsapp({
      platform: "WHATSAPP",
      isActive: true,
      token: "vendor-key",
      meta: {},
    });
    expect(resolved).toMatchObject({ status: "BLOCKED", code: "not-implemented" });
    if ("adapter" in resolved) throw new Error("expected no adapter");
    expect(resolved.message).toContain("your own WhatsApp Business account");
  });
});
