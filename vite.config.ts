import { defineConfig } from 'vitest/config';
import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';

export default defineConfig({
	server: {
		allowedHosts: ['ip-cam-master.local']
	},
	plugins: [tailwindcss(), sveltekit()],
	test: {
		include: ['src/**/*.test.ts'],
		globalSetup: ['./scripts/build/vitest-global-setup.mjs']
	}
});
