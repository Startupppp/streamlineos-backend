import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { cursorPageSchema } from "../../../../common/openapi/response-envelopes";
import { projectStatusEnum } from "../../../../db/schema";

export const teamRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  key: z.string(),
  icon: z.string().nullable(),
  color: z.string().nullable(),
  isPrivate: z.boolean(),
  capacity: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
});

export const teamListItemSchema = teamRowSchema
  .omit({ deletedAt: true })
  .extend({ memberCount: z.number().int() });

export const teamPageSchema = cursorPageSchema(teamListItemSchema);

export const teamDetailSchema = teamRowSchema.extend({
  members: z.array(z.object({
    userId: z.string(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    email: z.string(),
    image: z.string().nullable(),
    role: z.string(),
  })),
});

const teamMemberItemSchema = z.object({
  id: z.number().int(),
  userId: z.string(),
  role: z.string(),
  joinedAt: wireDate(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  email: z.string(),
  image: z.string().nullable(),
});

export const teamMemberPageSchema = cursorPageSchema(teamMemberItemSchema);

export const teamMemberRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  teamId: z.number().int(),
  membershipId: z.number().int(),
  role: z.string(),
  joinedAt: wireDate(),
});

export const teamProjectRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  projectId: z.number().int(),
  teamId: z.number().int(),
  addedAt: wireDate(),
});

export const teamProjectItemSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  key: z.string(),
  status: z.enum(projectStatusEnum.enumValues),
  addedAt: wireDate(),
});

