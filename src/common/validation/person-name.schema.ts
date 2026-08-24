import { z } from "zod";

const HAS_LETTER = /\p{L}/u;
const NAME_SHAPE = /^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u;
const CONSECUTIVE_SPACES = /\s{2}/;

export const PERSON_NAME_MAX = 200;

export const personNameSchema = z
  .string()
  .trim()
  .min(2, "Enter a valid name")
  .max(PERSON_NAME_MAX, `Name must be at most ${PERSON_NAME_MAX} characters`)
  .refine((value) => HAS_LETTER.test(value), "Enter a valid name")
  .refine(
    (value) => NAME_SHAPE.test(value),
    "Use only letters, spaces, apostrophes, hyphens and periods",
  )
  .refine(
    (value) => !CONSECUTIVE_SPACES.test(value),
    "Remove the extra spaces from this name",
  );
