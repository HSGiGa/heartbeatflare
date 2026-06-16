import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: './wrangler.jsonc' },
			// Test-only Worker Secret backing the heartbeat token (D1 stores `secret:TEST_BEAT_TOKEN`).
			miniflare: {
				bindings: {
					TEST_BEAT_TOKEN: 'beat-secret-xyz',
					TEST_TG_TOKEN: 'telegram-secret-xyz',
					TEST_WEBHOOK_URL: 'https://webhook.example.com/hook',
					TEST_WEBHOOK_TOKEN: 'webhook-secret-abc',
					// Custom HTTP probe headers (Issue #16). PROBE_HEADERS maps monitor id → headers with
					// ${VAR} placeholders; TEST_MONITOR_SECRET backs the placeholder for the resolve test.
					TEST_MONITOR_SECRET: 'sekret',
					PROBE_HEADERS: JSON.stringify({ 'http-hdr': { 'X-Monitor-Secret': '${TEST_MONITOR_SECRET}' } }),
				},
			},
		}),
	],
	test: {},
});
