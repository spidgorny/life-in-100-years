import type { ImageProvider } from './image-provider.js';

interface StabilityAiProviderOptions {
	apiKey?: string;
	endpoint?: string;
	outputFormat?: string;
}

interface StabilityJsonResponse {
	image?: string;
	artifacts?: Array<{ base64?: string }>;
}

export class StabilityAiProvider implements ImageProvider {
	private readonly apiKey?: string;
	private readonly endpoint: string;
	private readonly outputFormat: string;

	constructor(options: StabilityAiProviderOptions = {}) {
		this.apiKey = options.apiKey || process.env.STABILITY_API_KEY;
		this.endpoint =
			options.endpoint ||
			process.env.STABILITY_API_ENDPOINT ||
			'https://api.stability.ai/v2beta/stable-image/generate/ultra';
		this.outputFormat =
			options.outputFormat || process.env.STABILITY_OUTPUT_FORMAT || 'png';
	}

	get name(): string {
		return 'stability-ai';
	}

	async generate(prompt: string): Promise<Buffer> {
		if (!this.apiKey) {
			throw new Error('Missing Stability AI API key. Set STABILITY_API_KEY.');
		}

		const response = await fetch(this.endpoint, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${this.apiKey}`,
				'Content-Type': 'application/json',
				Accept: 'image/*, application/json',
			},
			body: JSON.stringify({
				prompt,
				aspect_ratio: '16:9',
				output_format: this.outputFormat,
			}),
		});

		if (!response.ok) {
			const errorBody = await response.text();
			throw new Error(`Stability AI request failed (${response.status}): ${errorBody}`);
		}

		const contentType = response.headers.get('content-type') || '';

		if (contentType.startsWith('image/')) {
			const arrayBuffer = await response.arrayBuffer();
			return Buffer.from(arrayBuffer);
		}

		const payload = (await response.json()) as StabilityJsonResponse;

		if (payload.image) {
			return Buffer.from(payload.image, 'base64');
		}

		if (payload.artifacts?.[0]?.base64) {
			return Buffer.from(payload.artifacts[0].base64, 'base64');
		}

		throw new Error(
			`Stability AI response did not contain image bytes: ${JSON.stringify(payload)}`
		);
	}
}
