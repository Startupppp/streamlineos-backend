import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './src/db/schema';
import { eq, inArray } from 'drizzle-orm';

async function main() {
  const connectionString = process.env.APP_DATABASE_URL;
  if (!connectionString) {
    console.error('APP_DATABASE_URL not set');
    process.exit(1);
  }
  const client = postgres(connectionString);
  const db = drizzle(client, { schema });

  const orgId = '0ca42108-a4c3-424f-8f11-f0acdd192114';
  const placement = await db.query.organizationPlacement.findFirst({
    where: eq(schema.organizationPlacement.organizationId, orgId),
  });

  if (!placement) {
    console.log('Placement missing for org', orgId);
  } else {
    console.log('Placement found:', placement);
  }
  
  process.exit(0);
}
main();
