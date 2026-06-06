import { handleQueue } from './queue';
import { handleFetch } from './routes';
import { handleScheduled } from './scheduler';

export default {
	async fetch(request, env, ctx): Promise<Response> {
		return handleFetch(request, env);
	},

	async scheduled(event, env, ctx): Promise<void> {
		await handleScheduled(env);
	},

	async queue(batch, env): Promise<void> {
		await handleQueue(batch, env);
	},
} satisfies ExportedHandler<Env>;
