process.env.APP_URL ??= "http://localhost:1000";

import { readFileSync } from "node:fs";
import { join } from "node:path";

const controllerSources = [
  "attendance.controller.ts",
  "employee-attendance.controller.ts",
].map((controllerFilename) =>
  readFileSync(join(__dirname, controllerFilename), "utf8"),
);

describe("attendance command safety", () => {
  it.each([
    ["checkIn", "hr.attendance.check-in"],
    ["checkOut", "hr.attendance.check-out"],
    ["toggleBreak", "hr.attendance.toggle-break"],
  ] as const)(
    "permanently fences %s and forwards its command key",
    (handlerName, commandScope) => {
      for (const controllerSource of controllerSources) {
        const decoratorStart = controllerSource.indexOf(
          `@Idempotent("${commandScope}")`,
        );
        const handlerStart = controllerSource.indexOf(
          `${handlerName}(`,
          decoratorStart,
        );
        const handlerSource = controllerSource.slice(
          decoratorStart,
          handlerStart + 500,
        );

        expect(decoratorStart).toBeGreaterThan(-1);
        expect(handlerStart).toBeGreaterThan(decoratorStart);
        expect(handlerSource).toContain(
          '@Headers("idempotency-key") idempotencyKey: string',
        );
        expect(handlerSource).toMatch(
          /this\.attendance\.[A-Za-z]+\([\s\S]*idempotencyKey/,
        );
      }
    },
  );
});
