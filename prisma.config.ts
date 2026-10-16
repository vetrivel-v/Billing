import { defineConfig } from 'prisma/config';

// Prisma 7 reads the connection URL from here, not from schema.prisma.
// A placeholder is used only so `prisma generate`/`validate` work without a database.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    url:
      process.env.DATABASE_URL ??
      'postgresql://placeholder:placeholder@127.0.0.1:54329/placeholder?schema=public',
  },
});
