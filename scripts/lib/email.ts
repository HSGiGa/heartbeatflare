export interface EmailChannelConfig {
	name: string;
	type: 'email';
	from: string;
	from_name?: string;
	to: string | string[];
	subject_prefix?: string;
	templates?: Record<string, string>;
	is_default?: boolean;
}

export interface EmailBindingConfig {
	name: 'EMAIL';
	allowed_sender_addresses: string[];
	allowed_destination_addresses: string[];
}

export function emailRecipients(channel: EmailChannelConfig): string[] {
	return Array.isArray(channel.to) ? channel.to : [channel.to];
}

export function collectEmailChannels(config: { notification_channels?: Array<{ type?: string }> }): EmailChannelConfig[] {
	return (config.notification_channels ?? []).filter((channel): channel is EmailChannelConfig => channel.type === 'email');
}

export function collectEmailSendersAndRecipients(channels: EmailChannelConfig[]): { senders: string[]; recipients: string[] } {
	const senders = new Set<string>();
	const recipients = new Set<string>();
	for (const channel of channels) {
		senders.add(channel.from);
		for (const recipient of emailRecipients(channel)) recipients.add(recipient);
	}
	return {
		senders: [...senders].sort(),
		recipients: [...recipients].sort(),
	};
}

export function buildEmailBinding(channels: EmailChannelConfig[]): EmailBindingConfig | null {
	if (channels.length === 0) return null;
	const { senders, recipients } = collectEmailSendersAndRecipients(channels);
	return {
		name: 'EMAIL',
		allowed_sender_addresses: senders,
		allowed_destination_addresses: recipients,
	};
}
