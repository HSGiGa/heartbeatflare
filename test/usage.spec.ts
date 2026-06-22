// Pure-lib tests for the usage-block reducers (Issue #31). Mirrors test/vpc.spec.ts style.
import { describe, it, expect } from 'vitest';
import { reduceQueueOperations, reduceTunnels, groupTunnels, serviceTunnelId, hourKeys, hourlySeries } from '../src/usage';
import type { VpcItemStatus } from '../src/types';

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

describe('groupTunnels', () => {
	it('shows a tunnel once with every binding that uses it', () => {
		const items: VpcItemStatus[] = [
			{ binding: 'NET_B', kind: 'network', id: 't1', status: 'healthy', name: 'api.tunnel', connections: 4, lastConnectedAt: '2026-06-21T09:00:00Z', createdAt: '2026-06-01T00:00:00Z' },
			{ binding: 'NET_A', kind: 'network', id: 't1', status: 'healthy', name: 'api.tunnel', connections: 4, lastConnectedAt: '2026-06-21T09:00:00Z', createdAt: '2026-06-01T00:00:00Z' },
		];
		expect(groupTunnels(items)).toEqual([
			{
				id: 't1',
				tunnelResolved: true,
				name: 'api.tunnel',
				status: 'healthy',
				connections: 4,
				lastConnectedAt: '2026-06-21T09:00:00Z',
				createdAt: '2026-06-01T00:00:00Z',
				bindings: [
					{ binding: 'NET_A', kind: 'network' }, // sorted by binding name
					{ binding: 'NET_B', kind: 'network' },
				],
			},
		]);
	});

	it('joins a network and a service that resolve to the same tunnel', () => {
		const items: VpcItemStatus[] = [
			{ binding: 'NET', kind: 'network', id: 't1', status: 'healthy', name: 'shared', connections: 2 },
			{ binding: 'SVC', kind: 'service', id: 't1', status: 'healthy', name: 'shared', connections: 2 },
		];
		const groups = groupTunnels(items);
		expect(groups).toHaveLength(1);
		expect(groups[0].bindings).toEqual([
			{ binding: 'NET', kind: 'network' },
			{ binding: 'SVC', kind: 'service' },
		]);
	});

	it('keeps an unresolved service as its own group flagged tunnelResolved: false', () => {
		const items: VpcItemStatus[] = [
			{ binding: 'SVC', kind: 'service', id: 'service-123', status: null, tunnelResolved: false },
		];
		expect(groupTunnels(items)).toEqual([
			{
				id: 'service-123',
				tunnelResolved: false,
				name: 'SVC', // falls back to binding when the CF API gave no tunnel name
				status: null,
				connections: 0,
				lastConnectedAt: null,
				createdAt: null,
				bindings: [{ binding: 'SVC', kind: 'service' }],
			},
		]);
	});

	it('sources all status/metadata atomically from one canonical (non-null status) record', () => {
		// Same tunnel id, but the null-status entry carries stale/empty metadata that must be ignored.
		const items: VpcItemStatus[] = [
			{ binding: 'A', kind: 'network', id: 't1', status: null, connections: 0, lastConnectedAt: null, createdAt: null },
			{ binding: 'B', kind: 'network', id: 't1', status: 'healthy', name: 'real', connections: 7, lastConnectedAt: '2026-06-21T09:00:00Z', createdAt: '2026-06-01T00:00:00Z' },
		];
		const [group] = groupTunnels(items);
		expect(group.status).toBe('healthy');
		expect(group.name).toBe('real');
		expect(group.connections).toBe(7);
		expect(group.lastConnectedAt).toBe('2026-06-21T09:00:00Z');
		expect(group.createdAt).toBe('2026-06-01T00:00:00Z');
	});

	it('sorts groups by tunnel name', () => {
		const items: VpcItemStatus[] = [
			{ binding: 'Z', kind: 'network', id: 'tz', status: 'healthy', name: 'zulu', connections: 1 },
			{ binding: 'A', kind: 'network', id: 'ta', status: 'healthy', name: 'alpha', connections: 1 },
		];
		expect(groupTunnels(items).map((g) => g.name)).toEqual(['alpha', 'zulu']);
	});
});

describe('serviceTunnelId', () => {
	it('reads a backing tunnel from a VPC service network or resolver network', () => {
		expect(serviceTunnelId({ host: { network: { tunnel_id: 'network-tunnel' } } })).toBe('network-tunnel');
		expect(serviceTunnelId({ host: { resolver_network: { tunnel_id: 'resolver-tunnel' } } })).toBe('resolver-tunnel');
	});

	it('returns null when a VPC service has no tunnel association', () => {
		expect(serviceTunnelId({ host: { hostname: 'internal.example' } })).toBeNull();
	});
});
