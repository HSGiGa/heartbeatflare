// Shared mapping from a monitor's status to a display label + colour. Used by both the status
// page (status-page.ts) and the SVG badges (badge.ts) so the two never drift.
export function statusMeta(status: string | null, paused: boolean): { text: string; color: string } {
	if (paused) return { text: 'Paused', color: '#71717a' };
	switch (status ?? 'unknown') {
		case 'up':
			return { text: 'Operational', color: '#16a34a' };
		case 'degraded':
			return { text: 'Degraded', color: '#d97706' };
		case 'down':
			return { text: 'Outage', color: '#dc2626' };
		default:
			return { text: 'Unknown', color: '#71717a' };
	}
}
