import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
	plugins: [sveltekit()],
	// Target modern browsers that support top-level await
	build: {
		target: 'esnext'
	},
	resolve: {
		alias: {
			// Resolve workspace package to source so we don't need to rebuild
			// dist/ after every change during development.
			'@robelest/convex-embedded': path.resolve(
				__dirname,
				'../../packages/convex-embedded/src/index.ts'
			)
		}
	},
	server: {
		port: 3000,
		// Allow serving files outside the project root — needed for:
		//   - import.meta.glob for convex/ modules
		//   - workspace package source resolution
		fs: {
			allow: ['../../..']
		}
	}
});
