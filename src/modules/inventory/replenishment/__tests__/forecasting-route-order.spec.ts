import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("InvForecastingController route order", () => {
  it("checks the refresh endpoint before the productVariantId catch-all", () => {
    const source = readFileSync(
      join(__dirname, "../inv-forecasting.controller.ts"),
      "utf8",
    );

    expect(source.indexOf('@Post("versions/refresh")')).toBeGreaterThanOrEqual(0);
    expect(source.indexOf('@Post("versions/:productVariantId")')).toBeGreaterThanOrEqual(0);
    expect(source.indexOf('@Post("versions/refresh")')).toBeLessThan(
      source.indexOf('@Post("versions/:productVariantId")'),
    );
  });
});
