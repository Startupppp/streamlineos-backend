import { KbAskService } from "./kb-ask.service";
import { KbAskCitationService } from "./kb-ask-citations.service";
import { KbRetrievalService } from "./kb-retrieval.service";

describe("KbAskService citation delegation", () => {
  it("KbAskService constructor does not declare assertReplayCitations so callers must use KbAskCitationService directly", () => {
    const proto = KbAskService.prototype as Record<string, unknown>;
    expect(typeof proto["assertReplayCitations"]).toBe("undefined");
  });

  it("KbAskCitationService is the canonical assertReplayCitations owner", () => {
    const proto = KbAskCitationService.prototype as Record<string, unknown>;
    expect(typeof proto["assertReplayCitations"]).toBe("function");
  });

  it("KbAskService.ask uses the required KbRetrievalService parameter not an optional one", () => {
    const ctorLength = KbAskService.length;
    expect(ctorLength).toBeGreaterThan(0);
    const params = KbAskService.toString();
    expect(params).not.toContain("null = null");
  });
});
