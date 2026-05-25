import * as fs from 'node:fs/promises';
import {
	formatFetchFailure,
	logApiRequest,
	logApiResponse,
} from './api-debug.js';
import type { ImageProvider } from './image-provider.js';

interface ComfyUiProviderOptions {
	baseUrl?: string;
	workflowPath?: string;
	checkpointName?: string;
	negativePrompt?: string;
	width?: number;
	height?: number;
	steps?: number;
	cfg?: number;
	samplerName?: string;
	scheduler?: string;
	filenamePrefix?: string;
	pollIntervalMs?: number;
	timeoutMs?: number;
}

interface ComfyUiImageRef {
	filename: string;
	subfolder?: string;
	type?: string;
}

type ComfyUiWorkflow = Record<string, { inputs: Record<string, unknown>; class_type: string }>;

interface ComfyUiPromptResponse {
	prompt_id?: string;
	error?: string;
}

interface ComfyUiHistoryEntry {
	status?: {
		completed?: boolean;
		status_str?: string;
	};
	outputs?: Record<string, { images?: ComfyUiImageRef[] }>;
}

type ComfyUiHistoryResponse = Record<string, ComfyUiHistoryEntry>;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ComfyUiProvider implements ImageProvider {
	private readonly baseUrl: string;
	private readonly workflowPath?: string;
	private readonly checkpointName: string;
	private readonly negativePrompt: string;
	private readonly width: number;
	private readonly height: number;
	private readonly steps: number;
	private readonly cfg: number;
	private readonly samplerName: string;
	private readonly scheduler: string;
	private readonly filenamePrefix: string;
	private readonly pollIntervalMs: number;
	private readonly timeoutMs: number;

	constructor(options: ComfyUiProviderOptions = {}) {
		this.baseUrl = (options.baseUrl || process.env.COMFYUI_BASE_URL || 'http://127.0.0.1:8188').replace(
			/\/$/,
			''
		);
		this.workflowPath = options.workflowPath || process.env.COMFYUI_WORKFLOW_PATH;
		this.checkpointName =
			options.checkpointName ||
			process.env.COMFYUI_CHECKPOINT_NAME ||
			'sd_xl_base_1.0.safetensors';
		this.negativePrompt =
			options.negativePrompt ||
			process.env.COMFYUI_NEGATIVE_PROMPT ||
			'blurry, low quality, text, watermark, logo, generic landscape, empty skyline, abstract wallpaper';
		this.width = options.width || Number.parseInt(process.env.COMFYUI_WIDTH || '1344', 10);
		this.height = options.height || Number.parseInt(process.env.COMFYUI_HEIGHT || '768', 10);
		this.steps = options.steps || Number.parseInt(process.env.COMFYUI_STEPS || '28', 10);
		this.cfg = options.cfg || Number.parseFloat(process.env.COMFYUI_CFG || '6.5');
		this.samplerName = options.samplerName || process.env.COMFYUI_SAMPLER_NAME || 'euler';
		this.scheduler = options.scheduler || process.env.COMFYUI_SCHEDULER || 'normal';
		this.filenamePrefix =
			options.filenamePrefix || process.env.COMFYUI_FILENAME_PREFIX || 'life-in-100-years';
		this.pollIntervalMs =
			options.pollIntervalMs || Number.parseInt(process.env.COMFYUI_POLL_INTERVAL_MS || '1000', 10);
		this.timeoutMs =
			options.timeoutMs || Number.parseInt(process.env.COMFYUI_TIMEOUT_MS || '300000', 10);
	}

	get name(): string {
		return 'comfyui';
	}

	private buildDefaultWorkflow(prompt: string): ComfyUiWorkflow {
		return {
			'1': {
				inputs: {
					ckpt_name: this.checkpointName,
				},
				class_type: 'CheckpointLoaderSimple',
			},
			'2': {
				inputs: {
					text: prompt,
					clip: ['1', 1],
				},
				class_type: 'CLIPTextEncode',
			},
			'3': {
				inputs: {
					text: this.negativePrompt,
					clip: ['1', 1],
				},
				class_type: 'CLIPTextEncode',
			},
			'4': {
				inputs: {
					width: this.width,
					height: this.height,
					batch_size: 1,
				},
				class_type: 'EmptyLatentImage',
			},
			'5': {
				inputs: {
					seed: Math.floor(Math.random() * Number.MAX_SAFE_INTEGER),
					steps: this.steps,
					cfg: this.cfg,
					sampler_name: this.samplerName,
					scheduler: this.scheduler,
					denoise: 1,
					model: ['1', 0],
					positive: ['2', 0],
					negative: ['3', 0],
					latent_image: ['4', 0],
				},
				class_type: 'KSampler',
			},
			'6': {
				inputs: {
					samples: ['5', 0],
					vae: ['1', 2],
				},
				class_type: 'VAEDecode',
			},
			'7': {
				inputs: {
					filename_prefix: this.filenamePrefix,
					images: ['6', 0],
				},
				class_type: 'SaveImage',
			},
		};
	}

	private applyTemplatePlaceholders(value: unknown, prompt: string): unknown {
		if (typeof value === 'string') {
			return value
				.replaceAll('__PROMPT__', prompt)
				.replaceAll('__NEGATIVE_PROMPT__', this.negativePrompt)
				.replaceAll('__CHECKPOINT__', this.checkpointName)
				.replaceAll('__WIDTH__', String(this.width))
				.replaceAll('__HEIGHT__', String(this.height))
				.replaceAll('__STEPS__', String(this.steps))
				.replaceAll('__CFG__', String(this.cfg))
				.replaceAll('__SAMPLER__', this.samplerName)
				.replaceAll('__SCHEDULER__', this.scheduler)
				.replaceAll('__FILENAME_PREFIX__', this.filenamePrefix);
		}

		if (Array.isArray(value)) {
			return value.map((item) => this.applyTemplatePlaceholders(item, prompt));
		}

		if (value && typeof value === 'object') {
			return Object.fromEntries(
				Object.entries(value).map(([key, entry]) => [
					key,
					this.applyTemplatePlaceholders(entry, prompt),
				])
			);
		}

		return value;
	}

	private async loadWorkflow(prompt: string): Promise<ComfyUiWorkflow> {
		if (!this.workflowPath) {
			return this.buildDefaultWorkflow(prompt);
		}

		const raw = await fs.readFile(this.workflowPath, 'utf8');
		const parsed = JSON.parse(raw) as unknown;
		const promptCandidate =
			parsed &&
			typeof parsed === 'object' &&
			'prompt' in parsed &&
			(parsed as { prompt?: unknown }).prompt
				? (parsed as { prompt: unknown }).prompt
				: parsed;

		return this.applyTemplatePlaceholders(promptCandidate, prompt) as ComfyUiWorkflow;
	}

	private async enqueuePrompt(workflow: ComfyUiWorkflow): Promise<string> {
		const url = `${this.baseUrl}/prompt`;
		const headers = {
			'Content-Type': 'application/json',
		};
		const body = JSON.stringify({
			prompt: workflow,
		});

		await logApiRequest({
			provider: this.name,
			label: 'enqueue prompt',
			url,
			method: 'POST',
			headers,
			body,
		});

		let response: Response;

		try {
			response = await fetch(url, {
				method: 'POST',
				headers,
				body,
			});
		} catch (error) {
			throw new Error(
				formatFetchFailure({
					provider: this.name,
					label: 'enqueue prompt',
					url,
					error,
				})
			);
		}

		if (!response.ok) {
			const errorBody = await response.text();
			await logApiResponse({
				provider: this.name,
				label: 'enqueue prompt',
				url,
				status: response.status,
				statusText: response.statusText,
				body: errorBody,
			});
			throw new Error(`ComfyUI prompt request failed (${response.status}): ${errorBody}`);
		}

		const payload = (await response.json()) as ComfyUiPromptResponse;

		if (!payload.prompt_id) {
			throw new Error(`ComfyUI did not return a prompt_id: ${JSON.stringify(payload)}`);
		}

		return payload.prompt_id;
	}

	private extractImageRef(payload: ComfyUiHistoryResponse, promptId: string): ComfyUiImageRef | undefined {
		const entry = payload[promptId] || Object.values(payload)[0];

		if (!entry?.outputs) {
			return undefined;
		}

		for (const output of Object.values(entry.outputs)) {
			const image = output.images?.[0];
			if (image?.filename) {
				return image;
			}
		}

		return undefined;
	}

	private async waitForImage(promptId: string): Promise<ComfyUiImageRef> {
		const startedAt = Date.now();

		while (Date.now() - startedAt < this.timeoutMs) {
			const url = `${this.baseUrl}/history/${promptId}`;
			let response: Response;

			try {
				response = await fetch(url);
			} catch (error) {
				throw new Error(
					formatFetchFailure({
						provider: this.name,
						label: 'poll history',
						url,
						error,
					})
				);
			}

			if (!response.ok) {
				const errorBody = await response.text();
				await logApiResponse({
					provider: this.name,
					label: 'poll history',
					url,
					status: response.status,
					statusText: response.statusText,
					body: errorBody,
				});
				throw new Error(
					`ComfyUI history request failed (${response.status}): ${errorBody}`
				);
			}

			const payload = (await response.json()) as ComfyUiHistoryResponse;
			const imageRef = this.extractImageRef(payload, promptId);

			if (imageRef) {
				return imageRef;
			}

			await sleep(this.pollIntervalMs);
		}

		throw new Error(`ComfyUI image generation timed out after ${this.timeoutMs}ms.`);
	}

	private async fetchImage(imageRef: ComfyUiImageRef): Promise<Buffer> {
		const params = new URLSearchParams({
			filename: imageRef.filename,
		});

		if (imageRef.subfolder) {
			params.set('subfolder', imageRef.subfolder);
		}

		if (imageRef.type) {
			params.set('type', imageRef.type);
		}

		const url = `${this.baseUrl}/view?${params.toString()}`;
		let response: Response;

		try {
			response = await fetch(url);
		} catch (error) {
			throw new Error(
				formatFetchFailure({
					provider: this.name,
					label: 'fetch image',
					url,
					error,
				})
			);
		}

		if (!response.ok) {
			const errorBody = await response.text();
			await logApiResponse({
				provider: this.name,
				label: 'fetch image',
				url,
				status: response.status,
				statusText: response.statusText,
				body: errorBody,
			});
			throw new Error(`ComfyUI image fetch failed (${response.status}): ${errorBody}`);
		}

		return Buffer.from(await response.arrayBuffer());
	}

	async generate(prompt: string): Promise<Buffer> {
		const workflow = await this.loadWorkflow(prompt);
		const promptId = await this.enqueuePrompt(workflow);
		const imageRef = await this.waitForImage(promptId);
		return this.fetchImage(imageRef);
	}
}
