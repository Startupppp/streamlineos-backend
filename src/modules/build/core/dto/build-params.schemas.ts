import { z } from "zod";

const intId = z.coerce.number().int().positive();

export const projectIdParams = z.object({ projectId: intId }).strict();
