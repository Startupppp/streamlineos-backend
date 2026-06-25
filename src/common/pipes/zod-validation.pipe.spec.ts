import { z } from "zod";
import { ZodValidationPipe } from "./zod-validation.pipe";

const schema = z.object({ page: z.coerce.number().min(1), q: z.string().optional() });

describe("ZodValidationPipe", () => {
  const pipe = new ZodValidationPipe(schema);

  it("parses and coerces valid input", () => {
    expect(pipe.transform({ page: "2" })).toEqual({ page: 2 });
  });

  it("throws a ZodError on invalid input", () => {
    expect(() => pipe.transform({ page: "0" })).toThrow();
  });
});
