import { describe, it, expect, vi, afterEach } from 'vitest';
import { configureLogging, log, _resetLogLevel } from '../src/log';

const asEnv = (o: Record<string, unknown>) => o as unknown as Env;

afterEach(() => {
	_resetLogLevel();
	vi.restoreAllMocks();
});

describe('structured logger', () => {
	it('emits one structured JSON line with level + event + fields', () => {
		const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
		log('info', 'scheduler.tick', { due: 3 });
		expect(spy).toHaveBeenCalledTimes(1);
		expect(JSON.parse(spy.mock.calls[0][0] as string)).toEqual({ level: 'info', event: 'scheduler.tick', due: 3 });
	});

	it('suppresses debug at the default info level', () => {
		configureLogging(asEnv({})); // no LOG_LEVEL → info
		const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
		log('debug', 'check.ok', { monitorId: 'x' });
		expect(spy).not.toHaveBeenCalled();
	});

	it('emits debug when LOG_LEVEL=debug', () => {
		configureLogging(asEnv({ LOG_LEVEL: 'debug' }));
		const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
		log('debug', 'check.ok', { monitorId: 'x' });
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it('routes warn/error to their console methods', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		log('warn', 'notification.delivery_failed', { channelId: 'mattermost' });
		log('error', 'auth.error', { error: 'boom' });
		expect(warn).toHaveBeenCalledTimes(1);
		expect(error).toHaveBeenCalledTimes(1);
	});
});
