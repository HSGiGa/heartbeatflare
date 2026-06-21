// Pure-lib tests for the usage-block reducers (Issue #31). Mirrors test/vpc.spec.ts style.
import { describe, it, expect } from 'vitest';
import { reduceQueueOperations, reduceTunnels, hourKeys, hourlySeries } from '../src/usage';

describe('reduceQueueOperations', () => {
	it('maps WriteMessage to write operations and ReadMessage/DeleteMessage to consume operations', () => {
		const out = reduceQueueOperations([
			{ sum: { billableOperations: 4 }, dimensions: { actionType: 'WriteMessage' } },
			{ sum: { billableOperations: 9 }, dimensions: { actionType: 'ReadMessage' } },
			{ sum: { billableOperations: 3 }, dimensions: { actionType: 'DeleteMessage' } },
		]);
		expect(out).toEqual({ writeOperations: 4, consumeOperations: 12 });
	});

	it('ignores unknown action types and missing sums', () => {
		const out = reduceQueueOperations([
			{ dimensions: { actionType: 'WriteMessage' } }, // missing sum → 0
			{ sum: { billableOperations: 5 }, dimensions: { actionType: 'PurgeQueue' } }, // unknown → ignored
			{ sum: { billableOperations: 7 } }, // missing dimension → ignored
		]);
		expect(out).toEqual({ writeOperations: 0, consumeOperations: 0 });
	});

	it('returns zeros for an empty group list (queried OK, no traffic today)', () => {
		expect(reduceQueueOperations([])).toEqual({ writeOperations: 0, consumeOperations: 0 });
	});
});

describe('hourKeys', () => {
	it('produces N top-of-hour ISO keys ending at the current hour, oldest first', () => {
		const now = Date.parse('2026-06-21T09:37:42.000Z');
		const keys = hourKeys(now, 3);
		expect(keys).toEqual(['2026-06-21T07:00:00Z', '2026-06-21T08:00:00Z', '2026-06-21T09:00:00Z']);
	});
});

describe('hourlySeries', () => {
	const keys = ['2026-06-21T07:00:00Z', '2026-06-21T08:00:00Z', '2026-06-21T09:00:00Z'];

	it('aligns grouped rows to the key order and gap-fills missing hours with 0', () => {
		const groups = [
			{ sum: { rowsWritten: 30 }, dimensions: { datetimeHour: '2026-06-21T09:00:00Z' } },
			{ sum: { rowsWritten: 10 }, dimensions: { datetimeHour: '2026-06-21T07:00:00Z' } },
			// 08:00 missing -> 0
		];
		expect(hourlySeries(groups, 'rowsWritten', keys)).toEqual([10, 0, 30]);
	});

	it('treats a missing sum field as 0', () => {
		const groups = [{ dimensions: { datetimeHour: '2026-06-21T08:00:00Z' } }];
		expect(hourlySeries(groups, 'rowsWritten', keys)).toEqual([0, 0, 0]);
	});
});

describe('reduceTunnels', () => {
	it('keeps only displayable tunnels and derives connection details without exposing connection metadata', () => {
		const tunnels = reduceTunnels([
			{ id: 'b', name: 'zulu', status: 'inactive', connections: [] },
			{ id: 'a', name: 'alpha', status: 'healthy', created_at: '2026-06-01T00:00:00Z', connections: [{ opened_at: '2026-06-21T08:00:00Z' }, { opened_at: '2026-06-21T09:00:00Z' }] },
			{ id: 'missing-name' },
		]);
		expect(tunnels).toEqual([
			{ id: 'a', name: 'alpha', status: 'healthy', connections: 2, lastConnectedAt: '2026-06-21T09:00:00Z', createdAt: '2026-06-01T00:00:00Z' },
			{ id: 'b', name: 'zulu', status: 'inactive', connections: 0, lastConnectedAt: null, createdAt: null },
		]);
	});
});
