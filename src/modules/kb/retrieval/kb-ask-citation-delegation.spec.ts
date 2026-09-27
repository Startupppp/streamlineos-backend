import { KbAskService } from "./kb-ask.service";
import { KbAskCitationService } from "./kb-ask-citations.service";
import { KbRetrievalService } from "./kb-retrieval.service";

describe("KbAskService citation delegation", () => {
  it("KbAskService constructor does not declare assertReplayCitations so callers must use KbAskCitationService directly", () => {
    const proto = KbAskService.prototype as unknown as Record<string, unknown>;
    expect(typeof proto["assertReplayCitations"]).toBe("undefined");
  });

  it("KbAskCitationService is the canonical assertReplayCitations owner", () => {
    const proto = KbAskCitationService.prototype as unknown as Record<string, unknown>;
    expect(typeof proto["assertReplayCitations"]).toBe("function");
  });

  it("KbAskService declares all eight constructor parameters as required, so retrieval cannot be defaulted away and silently leave gatherContext calling undefined", () => {
    expect(KbAskService.length).toBe(8);
  });

  it("KbRetrievalService owns retrieve, so the eighth parameter has somewhere to resolve from", () => {
    const proto = KbRetrievalService.prototype as unknown as Record<string, unknown>;
    expect(typeof proto["retrieve"]).toBe("function");
  });
});
