import { ConflictException } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { organizations } from "../../../db/schema";
import type { Db } from "../../../db/drizzle.types";
import { isUniqueViolationOn } from "../../../common/db/postgres-error";

const TOKEN_PREFIX = "rm_";
const TOKEN_BYTES = 24;
const TOKEN_INDEX = "uq_organizations_roadmap_public_token";

export interface RoadmapPublication {
  token: string | null;
  path: string | null;
}

function mintToken(): string {
  return TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString("base64url");
}

function publicationOf(token: string | null): RoadmapPublication {
  return { token, path: token === null ? null : `/roadmap/${token}` };
}

async function currentToken(db: Db, orgId: string): Promise<string | null> {
  const [row] = await db
    .select({ token: organizations.roadmapPublicToken })
    .from(organizations)
    .where(and(eq(organizations.id, orgId), isNull(organizations.deletedAt)))
    .limit(1);
  return row?.token ?? null;
}

async function writeToken(db: Db, orgId: string, token: string | null): Promise<void> {
  try {
    await db
      .update(organizations)
      .set({ roadmapPublicToken: token, updatedAt: new Date() })
      .where(and(eq(organizations.id, orgId), isNull(organizations.deletedAt)));
  } catch (error) {
    if (isUniqueViolationOn(error, TOKEN_INDEX)) {
      throw new ConflictException("Roadmap publication token collided, retry the request");
    }
    throw error;
  }
}

export async function readRoadmapPublication(db: Db, orgId: string): Promise<RoadmapPublication> {
  return publicationOf(await currentToken(db, orgId));
}

export async function publishRoadmap(db: Db, orgId: string): Promise<RoadmapPublication> {
  const existing = await currentToken(db, orgId);
  if (existing !== null) return publicationOf(existing);
  const token = mintToken();
  await writeToken(db, orgId, token);
  return publicationOf(token);
}

export async function rotateRoadmapPublicationToken(
  db: Db,
  orgId: string,
): Promise<RoadmapPublication> {
  const token = mintToken();
  await writeToken(db, orgId, token);
  return publicationOf(token);
}

export async function unpublishRoadmap(db: Db, orgId: string): Promise<void> {
  await writeToken(db, orgId, null);
}
