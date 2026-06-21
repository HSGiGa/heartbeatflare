// Pure-lib tests for the usage-block reducers (Issue #31). Mirrors test/vpc.spec.ts style.
import { describe, it, expect } from 'vitest';
import { reduceQueueOperations } from '../src/usage';

describe('reduceQueueOperations', () => {
	it('maps WriteMessage to produced and ReadMessage/DeleteMessage to consumed', () => {
		const out = reduceQueueOperations([
			{ sum: { billableOperations: 4 }, dimensions: { actionType: 'WriteMessage' } },
			{ sum: { billableOperations: 9 }, dimensions: { actionType: 'ReadMessage' } },
			{ sum: { billableOperations: 3 }, dimensions: { actionType: 'DeleteMessage' } },
		]);
		expect(out).toEqual({ messagesProduced: 4, messagesConsumed: 12 });
	});

	it('ignores unknown action types and missing sums', () => {
		const out = reduceQueueOperations([
			{ dimensions: { actionType: 'WriteMessage' } }, // missing sum → 0
			{ sum: { billableOperations: 5 }, dimensions: { actionType: 'PurgeQueue' } }, // unknown → ignored
			{ sum: { billableOperations: 7 } }, // missing dimension → ignored
		]);
		expect(out).toEqual({ messagesProduced: 0, messagesConsumed: 0 });
	});

	it('returns zeros for an empty group list (queried OK, no traffic today)', () => {
		expect(reduceQueueOperations([])).toEqual({ messagesProduced: 0, messagesConsumed: 0 });
	});
});
