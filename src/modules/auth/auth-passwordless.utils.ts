import { ServiceUnavailableException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";
import { users } from "../../db/schema";
import type { Db } from "../../db/drizzle.module";

export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" ? value : undefined;
}

export function serializeEmailError(error: unknown): Record<string, unknown> {
  if (!isRecord(error)) return { message: String(error) };
  const cause = isRecord(error.cause) ? error.cause : null;
  const causeStatus = cause?.statusCode;
  return {
    name: stringField(error, "name"),
    message: stringField(error, "message") ?? String(error),
    permanent: typeof error.permanent === "boolean" ? error.permanent : undefined,
    causeMessage: cause ? stringField(cause, "message") : undefined,
    causeStatus: typeof causeStatus === "number" ? causeStatus : undefined,
    causeName: cause ? stringField(cause, "name") : undefined,
  };
}

export async function findOrCreateUser(
  db: Db,
  email: string,
): Promise<{ id: string; email: string }> {
  const normalizedEmail = email.toLowerCase().trim();

  const existing = await db.query.users.findFirst({
    where: sql`lower(${users.email}) = ${normalizedEmail}`,
    columns: { id: true, email: true },
  });
  if (existing) return existing;

  const displayName = normalizedEmail.split("@")[0] || normalizedEmail;
  const [created] = await db
    .insert(users)
    .values({
      id: randomUUID(),
      email: normalizedEmail,
      name: displayName,
      firstName: displayName,
      lastName: "",
      isActive: true,
      emailVerified: null,
    })
    .onConflictDoNothing()
    .returning({ id: users.id, email: users.email });
  if (created) return created;

  const row = await db.query.users.findFirst({
    where: sql`lower(${users.email}) = ${normalizedEmail}`,
    columns: { id: true, email: true },
  });
  if (!row)
    throw new ServiceUnavailableException(
      "Could not start sign-in. Please try again.",
    );
  return row;
}
