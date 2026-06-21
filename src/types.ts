// Shared shapes: D1 row types (suffix DbRow mirrors column names), probe results, queue
// messages and view models. No runtime code.
export type MonitorDbRow = {
	id: string;
	name: string;
	type: string;
	mode: string;
	visibility: string;
	scrape_url: string | null;
	interval_seconds: number;
	enabled: number;
	paused: number;
	created_at: string;
	updated_at: string;
	status: string | null;
	last_check_at: string | null;
	last_success_at: string | null;
	consecutive_failures: number | null;
	consecutive_successes: number | null;
	active_incident_id: string | null;
	ssl_not_after: string | null;
	ssl_issuer: string | null;
};

export type AlertRuleDbRow = {
	id: string;
	monitor_id: string;
	metric_name: string | null;
	condition: string;
	threshold: number;
	severity: string;
	failure_count: number;
	recovery_count: number;
	cooldown_seconds: number;
	escalation_seconds: number | null;
	enabled: number;
};

export type MonitorRow = {
	id: string;
	name: string;
	type: 'http' | 'tcp' | 'dns' | 'heartbeat';
	scrape_url: string | null;
	interval_seconds: number;
	ssl_check: number;
	// Workers VPC binding name for mode: internal monitors (Issue #18); null for external.
	vpc_binding: string | null;
	current_status: string | null;
	last_check_at: string | null;
	consecutive_failures: number;
	consecutive_successes: number;
	active_incident_id: string | null;
	ssl_not_after: string | null;
	ssl_issuer: string | null;
};

export type ProbeResult = {
	status: 'up' | 'down';
	latency_ms: number;
	tcp_connect_ms?: number;
	ssl_error?: boolean;
	ssl_days_left?: number;
	ssl_not_after?: string;
	ssl_issuer?: string;
	error?: string;
};

export type NotificationMessage = {
	incidentId: string;
	monitorId: string;
	monitorName: string;
	eventType: 'down' | 'recovered' | 'escalation';
	count: number;
	error?: string;
};

export type NotificationChannelDbRow = {
	id: string;
	name: string;
	type: string;
	configuration: string;
};

// Active (open) incident keyed by metric class — derived from incidents JOIN alert_rules.
// class is alert_rules.metric_name, or '__connectivity__' when metric_name IS NULL.
export type ActiveIncidentRow = { monitor_id: string; class: string; incident_id: string; severity: string };
export type ActiveIncident = { id: string; severity: string };

// A maintenance window plus the ids of the monitors it affects (empty = global, all monitors).
export type MaintenanceWindowRow = {
	id: string;
	title: string;
	body: string | null;
	starts_at: string;
	ends_at: string;
	monitor_ids: string[];
};

export type UptimeDayRow = { monitor_id: string; day: string; avg_up: number };
export type LatencyRow = { monitor_id: string; latency_ms: number };
export type IncidentRow = {
	id: string;
	monitor_id: string;
	severity: string;
	status?: string;
	started_at: string;
	resolved_at: string | null;
	reason: string | null;
	monitor_name?: string;
	monitor_type?: string;
};

export type RuntimeEnv = Env & {
	CLOUDFLARE_ACCOUNT_ID?: string;
	D1_DATABASE_ID?: string;
	CLOUDFLARE_RUNTIME_API_TOKEN?: string;
	WORKER_NAME?: string;
	// Generated at deploy time from package.json: the deployed version, shown in the status page footer.
	APP_VERSION?: string;
	// Generated at deploy time from config.yaml site.title: the status page heading + browser tab title.
	// Empty falls back to "HeartbeatFlare".
	SITE_TITLE?: string;
	// Generated at deploy time from config.yaml: JSON map of monitor id → custom HTTP probe headers,
	// with ${VAR} placeholders preserved (resolved against env at probe runtime). Non-secret.
	PROBE_HEADERS?: string;
};

// A Cloudflare Workers VPC binding (Issue #18): vpc_networks and vpc_services expose the same probe
// surface — fetch() for HTTP, connect() for raw TCP. Bindings are optional (only present when
// deploy.vpc is configured) and accessed dynamically by name, so this is kept structural.
export type VpcBinding = {
	fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
	connect: (address: string) => Socket;
};

export type D1Usage = {
	readQueries: number;
	writeQueries: number;
	rowsRead: number;
	rowsWritten: number;
	databaseSizeBytes: number;
};

export type D1UsagePercent = {
	rowsRead: number;
	rowsWritten: number;
	storage: number;
};

export type WorkersUsage = {
	requests: number;
	errors: number;
	subrequests: number;
};

export type QueueUsage = {
	messagesProduced: number;
	messagesConsumed: number;
};

export type CronUsage = {
	scheduledInvocations: number;
	scheduledErrors: number;
};

export type PlanInfo = {
	label: string;
	rowsRead: number;
	rowsWritten: number;
	storageBytes: number;
};

export type UsageSnapshot = {
	d1: D1Usage;
	d1Percent: D1UsagePercent;
	workers: WorkersUsage | null;
	queues: QueueUsage | null;
	cron: CronUsage | null;
	fetchedAt: string | null;
	plan: PlanInfo | null;
};

export type AuthConfigDbRow = {
	id: string;
	provider: string;
	team_name: string;
	aud: string;
	enabled: number;
};

export type ResolvedAuthConfig = {
	provider: 'cloudflare_access';
	team_name: string;
	aud: string;
};

export type Session = {
	email: string;
	name: string;
};

export type UsageGraphQLResponse = {
	data?: {
		viewer?: {
			accounts?: Array<{
				d1AnalyticsAdaptiveGroups?: Array<{
					sum?: Partial<Omit<D1Usage, 'databaseSizeBytes'> & { queryBatchResponseBytes: number }>;
				}>;
				d1StorageAdaptiveGroups?: Array<{
					max?: Partial<Pick<D1Usage, 'databaseSizeBytes'>>;
				}>;
				workersInvocationsAdaptive?: Array<{
					sum?: Partial<WorkersUsage>;
				}>;
				queueMessageOperationsAdaptiveGroups?: Array<{
					sum?: { messagesProduced?: number; messagesConsumed?: number };
				}>;
				workersScheduledEventsAdaptiveGroups?: Array<{
					sum?: { scheduledSuccesses?: number; scheduledErrors?: number };
				}>;
			}>;
		};
	};
	errors?: unknown[];
};
