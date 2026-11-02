import { defineConfig } from 'drizzle-kit';

export default defineConfig({
	schema: './src/lib/server/db/schema.ts',
	dbCredentials: { url: './data/ip-cam-master.db' },
	dialect: 'sqlite'
});
