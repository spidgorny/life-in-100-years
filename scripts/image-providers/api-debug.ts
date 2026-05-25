const debugApi =
	process.env.IMAGE_API_DEBUG === '1' ||
	process.env.IMAGE_API_DEBUG === 'true' ||
	process.env.DEBUG_IMAGE_API === '1' ||
	process.env.DEBUG_IMAGE_API === 'true';

function truncate(value: string, maxLength = 1600): string {
	if (value.length <= maxLength) {
		return value;
	}

	return `${value.slice(0, maxLength)}… [truncated ${value.length - maxLength} chars]`;
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(headers).map(([key, value]) => {
			if (/authorization|api-key|token/i.test(key)) {
				return [key, '[redacted]'];
			}

			return [key, value];
		})
	);
}

async function describeBody(body: BodyInit | null | undefined): Promise<unknown> {
	if (!body) {
		return undefined;
	}

	if (typeof body === 'string') {
		return truncate(body);
	}

	if (body instanceof FormData) {
		const entries: Record<string, string> = {};

		body.forEach((value, key) => {
			entries[key] = typeof value === 'string' ? truncate(value, 400) : '[binary]';
		});

		return entries;
	}

	return `[body type: ${body.constructor?.name || typeof body}]`;
}

export async function logApiRequest(input: {
	provider: string;
	label: string;
	url: string;
	method: string;
	headers?: Record<string, string>;
	body?: BodyInit | null;
}): Promise<void> {
	if (!debugApi) {
		return;
	}

	const payload = {
		url: input.url,
		method: input.method,
		headers: redactHeaders(input.headers || {}),
		body: await describeBody(input.body),
	};

	console.error(`[${input.provider}] ${input.label} request\n${JSON.stringify(payload, null, 2)}`);
}

export async function logApiResponse(input: {
	provider: string;
	label: string;
	url: string;
	status: number;
	statusText: string;
	headers?: Record<string, string>;
	body?: string;
}): Promise<void> {
	if (!debugApi) {
		return;
	}

	const payload = {
		url: input.url,
		status: input.status,
		statusText: input.statusText,
		headers: input.headers || {},
		body: input.body ? truncate(input.body) : undefined,
	};

	console.error(`[${input.provider}] ${input.label} response\n${JSON.stringify(payload, null, 2)}`);
}

export function formatFetchFailure(input: {
	provider: string;
	label: string;
	url: string;
	error: unknown;
}): string {
	const error = input.error as Error & { cause?: unknown; code?: string };
	const cause =
		error?.cause && typeof error.cause === 'object'
			? JSON.stringify(error.cause)
			: String(error?.cause || '');

	return [
		`${input.provider} ${input.label} failed before an HTTP response was received.`,
		`URL: ${input.url}`,
		`Error: ${error?.name || 'Error'}: ${error?.message || String(input.error)}`,
		error?.code ? `Code: ${error.code}` : '',
		cause ? `Cause: ${cause}` : '',
		debugApi ? error?.stack || '' : '',
	]
		.filter(Boolean)
		.join('\n');
}
