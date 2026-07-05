import { NotFoundException } from "@nestjs/common";
import { SurveyAutomationService } from "./survey-automation.service";

function buildService(survey: { settings?: Record<string, unknown> } | null = { settings: {} }) {
  const setValues = jest.fn();
  const db = {
    query: {
      surveyForms: { findFirst: jest.fn().mockResolvedValue(survey) },
    },
    update: jest.fn(() => ({
      set: (values: unknown) => {
        setValues(values);
        return { where: jest.fn().mockResolvedValue(undefined) };
      },
    })),
  };
  const webhooksDispatch = { dispatch: jest.fn() };
  const service = new SurveyAutomationService(db as never, webhooksDispatch as never);
  return { service, db, setValues };
}

describe("SurveyAutomationService", () => {
  it("throws NotFoundException when the survey does not exist (or belongs to another org)", async () => {
    const { service } = buildService(null);
    await expect(service.list("org_1", 999)).rejects.toThrow(NotFoundException);
  });

  it("create() appends a new rule with a generated id and persists it", async () => {
    const { service, setValues } = buildService({ settings: { automations: [] } });
    const rule = await service.create("org_1", 1, {
      eventType: "survey.response.submitted",
      action: { type: "notify_owner" },
    });
    expect(rule.id).toBeTruthy();
    expect(setValues).toHaveBeenCalledWith(
      expect.objectContaining({ settings: expect.objectContaining({ automations: [rule] }) }),
    );
  });

  it("getRulesForEvent() only returns rules matching the given eventType", async () => {
    const existing = [
      { id: "a", eventType: "survey.response.submitted", action: { type: "create_lead" } },
      { id: "b", eventType: "survey.published", action: { type: "webhook" } },
    ];
    const { service } = buildService({ settings: { automations: existing } });
    const matched = await service.getRulesForEvent("org_1", 1, "survey.response.submitted");
    expect(matched).toEqual([existing[0]]);
  });

  it("getRulesForEvent() returns an empty array when nothing matches", async () => {
    const { service } = buildService({ settings: { automations: [{ id: "a", eventType: "survey.published", action: {} }] } });
    const matched = await service.getRulesForEvent("org_1", 1, "survey.response.submitted");
    expect(matched).toEqual([]);
  });

  it("patch() throws NotFoundException for an unknown automationId", async () => {
    const { service } = buildService({ settings: { automations: [] } });
    await expect(service.patch("org_1", 1, "missing", {})).rejects.toThrow(NotFoundException);
  });

  it("patch() merges the given fields into only the matching rule", async () => {
    const existing = [
      { id: "a", eventType: "survey.response.submitted", action: { type: "create_lead", scoreThreshold: 10 } },
      { id: "b", eventType: "survey.published", action: { type: "webhook" } },
    ];
    const { service, setValues } = buildService({ settings: { automations: existing } });
    const updated = await service.patch("org_1", 1, "a", { action: { type: "create_lead", scoreThreshold: 90 } });
    expect(updated.action).toEqual({ type: "create_lead", scoreThreshold: 90 });
    const savedRules = (setValues.mock.calls[0][0] as { settings: { automations: unknown[] } }).settings.automations;
    expect(savedRules).toHaveLength(2);
    expect(savedRules[1]).toEqual(existing[1]);
  });

  it("remove() drops only the targeted rule and leaves the rest untouched", async () => {
    const existing = [
      { id: "a", eventType: "survey.response.submitted", action: { type: "create_lead" } },
      { id: "b", eventType: "survey.published", action: { type: "webhook" } },
    ];
    const { service, setValues } = buildService({ settings: { automations: existing } });
    const result = await service.remove("org_1", 1, "a");
    expect(result).toEqual({ success: true });
    const savedRules = (setValues.mock.calls[0][0] as { settings: { automations: unknown[] } }).settings.automations;
    expect(savedRules).toEqual([existing[1]]);
  });
});
