import * as schema from "./schema";

export function getDb() {
  // If running in a Cloudflare environment, dynamically acquire D1 database:
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { env } = require("cloudflare:workers");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { drizzle } = require("drizzle-orm/d1");
    if (env?.DB) {
      return drizzle(env.DB, { schema });
    }
  } catch {
    // Cloudflare runtime bindings not present (e.g. Vercel or local Node)
  }

  throw new Error(
    "Cloudflare D1 database is not configured or unavailable in this environment."
  );
}

