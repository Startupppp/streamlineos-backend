import { BadRequestException } from "@nestjs/common";
import { resolveStructureTemplate } from "./workspace-onboarding.service";

describe("resolveStructureTemplate", () => {
  it("combines the industry structure with selected module teams", () => {
    const structure = resolveStructureTemplate("IT Services", [
      "crm",
      "build",
      "chat",
    ]);

    expect([...structure.keys()]).toEqual(
      expect.arrayContaining([
        "Engineering",
        "Product",
        "Operations",
        "HR",
        "Sales",
        "Marketing",
      ]),
    );
    expect([...(structure.get("Engineering") ?? [])]).toEqual(
      expect.arrayContaining(["Engineering Team", "Delivery Team"]),
    );
    expect([...(structure.get("Sales") ?? [])]).toEqual(["Revenue Team"]);
  });

  it("does not generate structures for modules that do not own org units", () => {
    const structure = resolveStructureTemplate("Agency", ["chat", "kb"]);

    expect([...structure.keys()]).toEqual([
      "Creative",
      "Strategy",
      "Client Services",
      "HR",
    ]);
  });

  it("rejects unsupported industries", () => {
    expect(() => resolveStructureTemplate("Unknown", ["hr"])).toThrow(
      BadRequestException,
    );
  });
});
