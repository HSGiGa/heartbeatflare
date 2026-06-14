import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: './wrangler.jsonc' },
			// Test-only Worker Secret backing the heartbeat token (D1 stores `secret:TEST_BEAT_TOKEN`).
			miniflare: { bindings: { TEST_BEAT_TOKEN: 'beat-secret-xyz', TEST_TG_TOKEN: 'telegram-secret-xyz' } },
		}),
	],
	test: {},
});
