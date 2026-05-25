import type { ImageProvider } from './image-provider.js';

interface GoogleImagenProviderOptions {
	model?: string;
	personGeneration?: string;
	apiKey?: string;
}

export class GoogleImagenProvider implements ImageProvider {
	private readonly model: string;
	private readonly personGeneration: string;
	private readonly apiKey?: string;

	constructor(options: GoogleImagenProviderOptions = {}) {
		this.model = options.model || process.env.IMAGEN_MODEL || 'imagen-4.0-generate-001';
		this.personGeneration =
			options.personGeneration ||
			process.env.IMAGEN_PERSON_GENERATION ||
			'allow_adult';
		this.apiKey =
			options.apiKey ||
			process.env.GEMINI_API_KEY ||
			process.env.GOOGLE_API_KEY ||
			process.env.GOOGLE_GEMINI_API_KEY;
	}

	get name(): string {
		return 'google-imagen';
	}

	private formatError(status: number, errorBody: string): string {
		if (
			status === 400 &&
			(errorBody.includes('only available on paid plans') ||
				errorBody.includes('Please upgrade your account'))
		) {
			return [
				'Imagen is not available for this Google AI Studio account tier.',
				'Upgrade the account at https://ai.dev/projects or switch IMAGE_PROVIDER=stability once a Stability API key is available.',
				`Original API error (${status}): ${errorBody}`,
			].join(' ');
		}

		return `Imagen request failed (${status}): ${errorBody}`;
	}

	async generate(prompt: string): Promise<Buffer> {
		if (!this.apiKey) {
			throw new Error(
				'Missing Google API key. Set GEMINI_API_KEY, GOOGLE_API_KEY, or GOOGLE_GEMINI_API_KEY.'
			);
		}

		const apiKey = this.apiKey;

		const requestImage = async (includePersonGeneration: boolean): Promise<Response> => {
			const parameters: Record<string, string | number> = {
				sampleCount: 1,
				aspectRatio: '16:9',
			};

			if (includePersonGeneration && this.personGeneration) {
				parameters.personGeneration = this.personGeneration;
			}

			return fetch(
				`https://generativelanguage.googleapis.com/v1beta/models/${this.model}:predict`,
				{
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'x-goog-api-key': apiKey,
					},
					body: JSON.stringify({
						instances: [{ prompt }],
						parameters,
					}),
				}
			);
		};

		let response = await requestImage(true);

		if (!response.ok) {
			const errorBody = await response.text();

			if (
				response.status === 400 &&
				errorBody.includes('personGeneration') &&
				errorBody.includes('not supported')
			) {
				response = await requestImage(false);
			} else {
				throw new Error(this.formatError(response.status, errorBody));
			}
		}

		if (!response.ok) {
			const errorBody = await response.text();
			throw new Error(this.formatError(response.status, errorBody));
		}

		const payload = (await response.json()) as {
			predictions?: Array<{ bytesBase64Encoded?: string }>;
		};
		const image = payload.predictions?.[0];

		if (!image?.bytesBase64Encoded) {
			throw new Error(`Imagen response did not contain image bytes: ${JSON.stringify(payload)}`);
		}

		return Buffer.from(image.bytesBase64Encoded, 'base64');
	}
}
