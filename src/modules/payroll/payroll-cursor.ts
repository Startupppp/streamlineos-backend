import { BadRequestException } from "@nestjs/common";
import {
  decodeCursor,
  type CursorPosition,
} from "../../common/pagination/cursor";

export type PayrollCursorScope = readonly (
  | string
  | number
  | boolean
  | null
)[];

interface ParsedPayrollCursor {
  readonly values: unknown[];
  readonly id: number;
}

function invalidCursor(): never {
  throw new BadRequestException("Invalid pagination cursor");
}

function parseCursor(
  value: string | undefined,
  expectedScope: PayrollCursorScope,
  allowZeroId = false,
): ParsedPayrollCursor | null {
  if (value === undefined) return null;

  const position = decodeCursor(value);
  if (!position) return invalidCursor();

  let payload: unknown;
  let outerValues: unknown;
  try {
    payload = JSON.parse(position.id);
    outerValues = JSON.parse(position.sortValue);
  } catch {
    return invalidCursor();
  }

  if (
    !Array.isArray(payload) ||
    payload.length !== 3 ||
    !Array.isArray(payload[0]) ||
    JSON.stringify(payload[0]) !== JSON.stringify(expectedScope) ||
    !Array.isArray(payload[1]) ||
    JSON.stringify(payload[1]) !== JSON.stringify(outerValues) ||
    typeof payload[2] !== "number" ||
    !Number.isSafeInteger(payload[2]) ||
    (allowZeroId ? payload[2] < 0 : payload[2] < 1)
  ) {
    return invalidCursor();
  }

  return { values: payload[1], id: payload[2] };
}

export function payrollCursorPosition(
  scope: PayrollCursorScope,
  values: readonly (string | number | null)[],
  id: number,
): CursorPosition {
  return {
    sortValue: JSON.stringify(values),
    id: JSON.stringify([scope, values, id]),
  };
}

export function decodePayrollTimestampCursor(
  value: string | undefined,
  scope: PayrollCursorScope,
): { createdAt: Date; id: number } | null {
  const parsed = parseCursor(value, scope);
  if (!parsed) return null;
  const raw = parsed.values[0];
  if (parsed.values.length !== 1 || typeof raw !== "string") return invalidCursor();
  const createdAt = new Date(raw);
  if (Number.isNaN(createdAt.getTime())) return invalidCursor();
  return { createdAt, id: parsed.id };
}

export function decodePayrollIdCursor(
  value: string | undefined,
  scope: PayrollCursorScope,
): { id: number } | null {
  const parsed = parseCursor(value, scope);
  if (!parsed) return null;
  if (parsed.values.length !== 1 || parsed.values[0] !== parsed.id) return invalidCursor();
  return { id: parsed.id };
}

export function decodePayrollTextCursor(
  value: string | undefined,
  scope: PayrollCursorScope,
): { value: string; id: number } | null {
  const parsed = parseCursor(value, scope);
  if (!parsed) return null;
  const cursorValue = parsed.values[0];
  if (parsed.values.length !== 1 || typeof cursorValue !== "string") return invalidCursor();
  return { value: cursorValue, id: parsed.id };
}

export function decodePayrollNullableTextCursor(
  value: string | undefined,
  scope: PayrollCursorScope,
): { value: string | null; id: number } | null {
  const parsed = parseCursor(value, scope, true);
  if (!parsed) return null;
  const cursorValue = parsed.values[0];
  if (
    parsed.values.length !== 1 ||
    (cursorValue !== null && typeof cursorValue !== "string")
  ) {
    return invalidCursor();
  }
  return { value: cursorValue, id: parsed.id };
}

export function decodePayrollNumberTextCursor(
  value: string | undefined,
  scope: PayrollCursorScope,
): { numberValue: number; textValue: string; id: number } | null {
  const parsed = parseCursor(value, scope);
  if (!parsed) return null;
  const numberValue = parsed.values[0];
  const textValue = parsed.values[1];
  if (
    parsed.values.length !== 2 ||
    typeof numberValue !== "number" ||
    !Number.isSafeInteger(numberValue) ||
    typeof textValue !== "string"
  ) {
    return invalidCursor();
  }
  return { numberValue, textValue, id: parsed.id };
}

export function decodePayrollTextTimestampCursor(
  value: string | undefined,
  scope: PayrollCursorScope,
): { textValue: string; createdAt: Date; id: number } | null {
  const parsed = parseCursor(value, scope);
  if (!parsed) return null;
  const textValue = parsed.values[0];
  const rawDate = parsed.values[1];
  if (
    parsed.values.length !== 2 ||
    typeof textValue !== "string" ||
    typeof rawDate !== "string"
  ) {
    return invalidCursor();
  }
  const createdAt = new Date(rawDate);
  if (Number.isNaN(createdAt.getTime())) return invalidCursor();
  return { textValue, createdAt, id: parsed.id };
}
