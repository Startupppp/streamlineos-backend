import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ParseResourceIdPipe } from "./parse-resource-id.pipe";

describe("ParseResourceIdPipe", () => {
  const pipe = new ParseResourceIdPipe();

  it("accepts a positive integer", () => {
    expect(pipe.transform("4")).toBe(4);
  });

  it.each(["projects", "goals", "my-work", "4a", "", " 4", "4 ", "+4"])(
    "treats %p as a path that does not exist, not a bad request",
    (value) => {
      expect(() => pipe.transform(value)).toThrow(NotFoundException);
    },
  );

  it.each(["0", "99999999999999999999"])(
    "rejects %p as a malformed reference, not a missing route",
    (value) => {
      expect(() => pipe.transform(value)).toThrow(BadRequestException);
    },
  );

  it("treats a negative id as a missing route, since the minus is not numeric", () => {
    expect(() => pipe.transform("-5")).toThrow(NotFoundException);
  });
});
