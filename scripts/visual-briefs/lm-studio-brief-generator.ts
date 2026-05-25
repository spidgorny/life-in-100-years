import {
	formatFetchFailure,
	logApiRequest,
	logApiResponse,
} from '../image-providers/api-debug.js';
import type { ChapterContext, VisualBrief } from './visual-brief.js';

interface LmStudioChatResponse {
	choices?: Array<{
		message?: {
			content?: string | Array<{ type?: string; text?: string }>;
		};
	}>;
}

export class LmStudioBriefGenerator {
	private readonly baseUrl: string;
	private readonly model: string;
	private readonly apiKey?: string;
	private readonly timeoutMs: number;

	constructor() {
		this.baseUrl = process.env.LM_STUDIO_BASE_URL || 'http://127.0.0.1:1234/v1';
		this.model = process.env.LM_STUDIO_MODEL || 'local-model';
		this.apiKey = process.env.LM_STUDIO_API_KEY;
		this.timeoutMs = Number.parseInt(process.env.LM_STUDIO_TIMEOUT_MS || '5000', 10);
	}

	private extractJson(text: string): string {
		const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
		if (fenced?.[1]) {
			return fenced[1].trim();
		}

		const start = text.indexOf('{');
		const end = text.lastIndexOf('}');

		if (start >= 0 && end > start) {
			return text.slice(start, end + 1);
		}

		return text.trim();
	}

	private getContent(payload: LmStudioChatResponse): string {
		const content = payload.choices?.[0]?.message?.content;

		if (typeof content === 'string') {
			return content;
		}

		if (Array.isArray(content)) {
			return content
				.map((item) => item.text || '')
				.join('\n')
				.trim();
		}

		throw new Error('LM Studio response did not contain message content.');
	}

	private normalizeBrief(input: Partial<VisualBrief>, fallback: VisualBrief): VisualBrief {
		return {
			title: fallback.title,
			summary: input.summary?.trim() || fallback.summary,
			theme: input.theme?.trim() || fallback.theme,
			visualScene: input.visualScene?.trim() || fallback.visualScene,
			keyElements:
				input.keyElements?.filter((item) => typeof item === 'string' && item.trim()).slice(0, 6) ||
				fallback.keyElements,
			mood: input.mood?.trim() || fallback.mood,
			negativePrompt: input.negativePrompt?.trim() || fallback.negativePrompt,
		};
	}

	async generate(chapter: ChapterContext, fallback: VisualBrief): Promise<VisualBrief> {
		const prompt = [
			'Create a JSON object for an image-generation visual brief for a single chapter banner.',
			'The banner is for a nonfiction futurist book and should produce a human-centered, concrete scene rather than a generic landscape.',
			'Return JSON only with these keys: summary, theme, visualScene, keyElements, mood, negativePrompt.',
			'keyElements must be an array of 3 to 6 short concrete visual nouns or noun phrases.',
			'negativePrompt should explicitly exclude generic skylines, empty landscapes, text overlays, logos, UI, maps, diagrams, and irrelevant fantasy imagery.',
			`Chapter title: ${chapter.title}`,
			`Current summary: ${chapter.summary}`,
			`Fallback theme: ${fallback.theme}`,
			`Fallback visual scene: ${fallback.visualScene}`,
			`Chapter text:\n${chapter.fullText}`,
		].join('\n\n');

		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
		};

		if (this.apiKey) {
			headers.Authorization = `Bearer ${this.apiKey}`;
		}

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

		const url = `${this.baseUrl}/chat/completions`;
		let response: Response;
		const body = JSON.stringify({
			model: this.model,
			temperature: 0.2,
			messages: [
				{
					role: 'system',
					content:
						'You are a visual-brief generator. Output valid JSON only. Focus on concrete scene direction for image generation.',
				},
				{
					role: 'user',
					content: prompt,
				},
			],
		});

		await logApiRequest({
			provider: 'lmstudio',
			label: 'generate visual brief',
			url,
			method: 'POST',
			headers,
			body,
		});

		try {
			response = await fetch(url, {
				method: 'POST',
				headers,
				signal: controller.signal,
				body,
			});
		} catch (error) {
			if ((error as Error).name === 'AbortError') {
				throw new Error(
					`LM Studio request timed out after ${this.timeoutMs}ms at ${this.baseUrl}.`
				);
			}

			throw new Error(
				formatFetchFailure({
					provider: 'lmstudio',
					label: 'generate visual brief',
					url,
					error,
				})
			);
		} finally {
			clearTimeout(timeout);
		}

		if (!response.ok) {
			const errorBody = await response.text();
			await logApiResponse({
				provider: 'lmstudio',
				label: 'generate visual brief',
				url,
				status: response.status,
				statusText: response.statusText,
				body: errorBody,
			});
			throw new Error(`LM Studio request failed (${response.status}): ${errorBody}`);
		}

		const payload = (await response.json()) as LmStudioChatResponse;
		const content = this.getContent(payload);
		const parsed = JSON.parse(this.extractJson(content)) as Partial<VisualBrief>;
		return this.normalizeBrief(parsed, fallback);
	}
}
