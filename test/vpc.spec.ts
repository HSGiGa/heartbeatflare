// Workers VPC config helpers (Issue #18). Pure-lib tests for validation, ${VAR} substitution, and
// wrangler binding generation — mirrors test/probes.spec.ts (generate-time helpers in the WP pool).
import { describe, it, expect } from 'vitest';
import { buildEmailBinding, collectEmailChannels, collectEmailSendersAndRecipients } from '../scripts/lib/email';
import { buildVpcBindings, collectVpcBindingNames, resolveVpcId, validateMonitorVpc, validateVpcConfig } from '../scripts/lib/vpc';

describe('email config helpers', () => {
	it('collects only email notification channels', () => {
		const channels = collectEmailChannels({
			notification_channels: [
				{ type: 'webhook' },
				{ name: 'Email', type: 'email', from: 'noreply@example.com', to: 'ops@example.com' },
			],
		});

		expect(channels).toEqual([
			{ name: 'Email', type: 'email', from: 'noreply@example.com', to: 'ops@example.com' },
		]);
	});

	it('deduplicates and sorts sender and recipient allowlists', () => {
		const out = collectEmailSendersAndRecipients([
			{ name: 'A', type: 'email', from: 'noreply@example.com', to: ['ops@example.com', 'alerts@example.com'] },
			{ name: 'B', type: 'email', from: 'noreply@example.com', to: 'ops@example.com' },
		]);

		expect(out).toEqual({
			senders: ['noreply@example.com'],
			recipients: ['alerts@example.com', 'ops@example.com'],
		});
	});

	it('builds a single EMAIL binding for configured email channels', () => {
		expect(
			buildEmailBinding([{ name: 'Email', type: 'email', from: 'noreply@example.com', to: 'ops@example.com' }]),
		).toEqual({
			name: 'EMAIL',
			allowed_sender_addresses: ['noreply@example.com'],
		});
	});

	it('omits the binding when no email channels are configured', () => {
		expect(buildEmailBinding([])).toBeNull();
	});
});

describe('validateVpcConfig', () => {
	it('accepts a tunnel-backed network and a scoped service', () => {
		expect(() =>
			validateVpcConfig({
				networks: [{ binding: 'NET', tunnel_id: 't' }],
				services: [{ binding: 'SVC', service_id: 's' }],
			}),
		).not.toThrow();
	});

	it('rejects network_id / Cloudflare Mesh', () => {
		expect(() => validateVpcConfig({ networks: [{ binding: 'NET', network_id: 'cf1:network' }] })).toThrowError(/network_id is unsupported/i);
	});

	it('requires tunnel_id on a network entry', () => {
		expect(() => validateVpcConfig({ networks: [{ binding: 'NET' }] })).toThrowError(/requires "tunnel_id"/);
	});

	it('requires service_id on a service entry', () => {
		expect(() => validateVpcConfig({ services: [{ binding: 'SVC' }] })).toThrowError(/requires "service_id"/);
	});

	it('requires a binding name', () => {
		expect(() => validateVpcConfig({ networks: [{ binding: '', tunnel_id: 't' }] })).toThrowError(/missing|without a "binding"/i);
	});

	it('rejects duplicate binding names across networks and services', () => {
		expect(() =>
			validateVpcConfig({
				networks: [{ binding: 'DUP', tunnel_id: 't' }],
				services: [{ binding: 'DUP', service_id: 's' }],
			}),
		).toThrowError(/declared more than once/);
	});
});

describe('collectVpcBindingNames', () => {
	it('collects names from both arrays', () => {
		const names = collectVpcBindingNames({ networks: [{ binding: 'NET', tunnel_id: 't' }], services: [{ binding: 'SVC', service_id: 's' }] });
		expect([...names].sort()).toEqual(['NET', 'SVC']);
	});

	it('is empty for undefined config', () => {
		expect(collectVpcBindingNames(undefined).size).toBe(0);
	});
});

describe('validateMonitorVpc', () => {
	const bindings = new Set(['DEMO_SERVICE']);

	it('accepts an internal http monitor referencing a known binding', () => {
		expect(() => validateMonitorVpc({ name: 'A', type: 'http', mode: 'internal', vpc_binding: 'DEMO_SERVICE' }, bindings)).not.toThrow();
	});

	it('accepts an external monitor with no vpc_binding', () => {
		expect(() => validateMonitorVpc({ name: 'A', type: 'http', mode: 'external' }, bindings)).not.toThrow();
	});

	it('rejects an external monitor carrying vpc_binding', () => {
		expect(() => validateMonitorVpc({ name: 'A', type: 'http', mode: 'external', vpc_binding: 'DEMO_SERVICE' }, bindings)).toThrowError(/only for mode: internal/);
	});

	it('rejects an internal monitor without vpc_binding', () => {
		expect(() => validateMonitorVpc({ name: 'A', type: 'http', mode: 'internal' }, bindings)).toThrowError(/no vpc_binding/);
	});

	it('rejects an internal monitor referencing an unknown binding', () => {
		expect(() => validateMonitorVpc({ name: 'A', type: 'http', mode: 'internal', vpc_binding: 'NOPE' }, bindings)).toThrowError(/not declared under deploy.vpc/);
	});

	it('rejects internal type dns', () => {
		expect(() => validateMonitorVpc({ name: 'A', type: 'dns', mode: 'internal', vpc_binding: 'DEMO_SERVICE' }, bindings)).toThrowError(/only http and tcp/);
	});

	it('rejects internal ssl: true', () => {
		expect(() => validateMonitorVpc({ name: 'A', type: 'http', mode: 'internal', ssl: true, vpc_binding: 'DEMO_SERVICE' }, bindings)).toThrowError(/SSL expiry checks are unsupported/);
	});
});

describe('resolveVpcId', () => {
	it('substitutes ${VAR} from env', () => {
		expect(resolveVpcId('${TID}', { TID: 'abc' }, { strict: true })).toBe('abc');
	});

	it('throws in strict mode on an unset var', () => {
		expect(() => resolveVpcId('${MISSING}', {}, { strict: true })).toThrowError(/references unset env var\(s\): MISSING/);
	});

	it('returns null in lenient mode on an unset var', () => {
		expect(resolveVpcId('${MISSING}', {}, { strict: false })).toBeNull();
	});

	it('passes a literal id through unchanged', () => {
		expect(resolveVpcId('literal-id', {}, { strict: true })).toBe('literal-id');
	});
});

describe('buildVpcBindings', () => {
	const vpc = {
		networks: [{ binding: 'NET', tunnel_id: '${TID}' }],
		services: [{ binding: 'SVC', service_id: '${SID}', remote: false }],
	};

	it('produces vpc_networks / vpc_services with remote defaulting to true', () => {
		const out = buildVpcBindings(vpc, { TID: 'tunnel-1', SID: 'svc-1' }, { isDeployMode: true });
		expect(out.vpc_networks).toEqual([{ binding: 'NET', tunnel_id: 'tunnel-1', remote: true }]);
		expect(out.vpc_services).toEqual([{ binding: 'SVC', service_id: 'svc-1', remote: false }]);
	});

	it('fails fast in deploy mode when a ${VAR} is unset', () => {
		expect(() => buildVpcBindings(vpc, { TID: 'tunnel-1' }, { isDeployMode: true })).toThrowError(/SVC.*service_id.*unset env var/);
	});

	it('omits unresolved bindings in local mode instead of failing', () => {
		const out = buildVpcBindings(vpc, { TID: 'tunnel-1' }, { isDeployMode: false });
		expect(out.vpc_networks).toEqual([{ binding: 'NET', tunnel_id: 'tunnel-1', remote: true }]);
		expect(out.vpc_services).toBeUndefined();
	});

	it('omits empty sections entirely', () => {
		const out = buildVpcBindings({}, {}, { isDeployMode: false });
		expect(out).toEqual({});
	});
});
