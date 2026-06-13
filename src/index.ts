// Worker entry point. One Worker, three entry points:
//   fetch()     — status pages + JSON API (routes.ts)
//   scheduled() — cron tick: probing, alerting, rollups, cleanup (scheduler.ts)
//   queue()     — notification delivery consumer (queue.ts)
import { configureLogging } from './log';
import { handleQueue } from './queue';
import { handleFetch } from './routes';
import { handleScheduled } from './scheduler';

export default {
	async fetch(request, env, ctx): Promise<Response> {
		configureLogging(env);
		return handleFetch(request, env, ctx);
	},

	async scheduled(event, env, ctx): Promise<void> {
		configureLogging(env);
		await handleScheduled(env);
	},

	async queue(batch, env): Promise<void> {
		configureLogging(env);
		await handleQueue(batch, env);
	},
} satisfies ExportedHandler<Env>;
