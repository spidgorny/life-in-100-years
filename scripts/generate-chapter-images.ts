#!/usr/bin/env node

import * as fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { ComfyUiProvider } from './image-providers/comfyui-provider.js';
import { GoogleImagenProvider } from './image-providers/google-imagen-provider.js';
import type { ImageProvider } from './image-providers/image-provider.js';
import { StabilityAiProvider } from './image-providers/stability-ai-provider.js';
import { LmStudioBriefGenerator } from './visual-briefs/lm-studio-brief-generator.js';
import type { ChapterContext, VisualBrief } from './visual-briefs/visual-brief.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');
const srcDir = path.join(rootDir, 'src');
const defaultOutputDir = path.join(rootDir, 'images', 'chapters');
const imageProviderName = (process.env.IMAGE_PROVIDER || 'comfyui').toLowerCase();
const visualBriefProvider = (process.env.VISUAL_BRIEF_PROVIDER || 'basic').toLowerCase();
const defaultComfyChapterWidth = 1024;
const defaultComfyChapterHeight = 576;
const defaultComfyChapterSteps = 12;
const defaultComfyChapterCfg = 5.5;
const defaultComfyChapterTimeoutMs = 900000;

const stylePrompt = [
	'Create a cinematic wide chapter banner for a nonfiction futurist book.',
	'Use a clean, elegant editorial illustration style with optimistic but grounded mood.',
	'Keep one coherent visual identity across all chapters.',
	'Show no words, letters, logos, captions, watermarks, UI elements, or book covers inside the image.',
	'Prefer strong composition, soft atmospheric light, rich detail, and a modern future aesthetic.',
].join(' ');

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const force = args.has('--force');
const debugPrompt = args.has('--debug-prompt');

for (const stream of [process.stdout, process.stderr]) {
	stream.on('error', (error: NodeJS.ErrnoException) => {
		if (error.code === 'EPIPE') {
			process.exit(0);
		}

		throw error;
	});
}

function stripMarkdown(text: string): string {
	return text
		.replace(/!\[[^\]]*]\([^)]*\)/g, '')
		.replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
		.replace(/`([^`]+)`/g, '$1')
		.replace(/[*_~>#-]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function getSummarySentences(text: string): string {
	const normalized = stripMarkdown(text);
	const sentences = normalized.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [];
	return sentences.slice(0, 3).join(' ').trim() || normalized;
}

function truncateAtWord(text: string, maxLength: number): string {
	if (text.length <= maxLength) {
		return text;
	}

	const shortened = text.slice(0, maxLength - 1);
	const lastSpace = shortened.lastIndexOf(' ');

	if (lastSpace <= 0) {
		return `${shortened.trimEnd()}…`;
	}

	return `${shortened.slice(0, lastSpace).trimEnd()}…`;
}

function extractKeywords(title: string, text: string, limit: number): string[] {
	const stopWords = new Set([
		'the',
		'and',
		'that',
		'with',
		'this',
		'from',
		'they',
		'their',
		'there',
		'about',
		'into',
		'would',
		'could',
		'should',
		'while',
		'where',
		'which',
		'when',
		'what',
		'will',
		'have',
		'has',
		'had',
		'more',
		'most',
		'than',
		'then',
		'being',
		'people',
		'person',
		'future',
		'world',
		'life',
		'chapter',
		'into',
		'through',
		'those',
		'these',
		'today',
		'2120',
		'year',
		'years',
		'many',
		'might',
		'still',
		'become',
		'becomes',
		'because',
		'everyday',
		'ordinary',
		'humans',
		'human',
		'society',
		'systems',
		'system',
		'less',
		'like',
		'longer',
		'shorter',
		'daily',
		'common',
		'often',
		'just',
		'very',
		'make',
		'makes',
		'made',
		'using',
		'used',
		'use',
		'also',
		'such',
		'other',
		'another',
		'every',
		'each',
		'between',
		'around',
		'across',
		'under',
		'over',
		'toward',
		'without',
		'within',
		'becomes',
		'became',
		'become',
		'whole',
		'large',
		'small',
		'better',
		'best',
		'good',
		'great',
		'clear',
		'simple',
		'first',
		'second',
		'third',
		'however',
		'therefore',
		'rather',
		'together',
		'local',
		'global',
		'modern',
		'old',
		'new',
		'work',
		'life',
	]);

	const counts = new Map<string, number>();
	const words = stripMarkdown(text)
		.toLowerCase()
		.match(/[a-z][a-z'-]{3,}/g);

	for (const word of words || []) {
		if (stopWords.has(word)) {
			continue;
		}

		counts.set(word, (counts.get(word) || 0) + 1);
	}

	const titleWords = stripMarkdown(title)
		.toLowerCase()
		.match(/[a-z][a-z'-]{3,}/g);

	for (const word of titleWords || []) {
		if (stopWords.has(word)) {
			continue;
		}

		counts.set(word, (counts.get(word) || 0) + 4);
	}

	return [...counts.entries()]
		.sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
		.slice(0, limit)
		.map(([word]) => word);
}

function inferMood(title: string, fullText: string): string {
	const sample = `${title} ${fullText}`.toLowerCase();

	if (/(crime|conflict|surveillance|laws|governance)/.test(sample)) {
		return 'thoughtful, tense, intelligent';
	}

	if (/(family|children|health|relations|education)/.test(sample)) {
		return 'warm, humane, hopeful';
	}

	if (/(climate|energy|food|cities|housing)/.test(sample)) {
		return 'optimistic, grounded, restorative';
	}

	return 'hopeful, grounded, thoughtful';
}

function buildDeterministicVisualBrief(chapter: ChapterContext): VisualBrief {
	const keywords = extractKeywords(chapter.title, chapter.fullText, 6);
	const keyElements =
		keywords.length > 0
			? keywords.map((keyword) => keyword.replace(/-/g, ' '))
			: ['future resident', 'human-scale setting', 'clear focal subject'];
	const mood = inferMood(chapter.title, chapter.fullText);

	return {
		title: chapter.title,
		summary: chapter.summary,
		theme: `${chapter.title} in a humane, post-scarcity future`,
		visualScene: [
			`A concrete human-centered scene that expresses "${chapter.title}" in the year 2120.`,
			`Use the chapter ideas to show a specific place, activity, or interaction rather than a broad skyline or empty landscape.`,
			`Ground the scene in these ideas: ${truncateAtWord(chapter.summary, 220)}`,
		].join(' '),
		keyElements,
		mood,
		negativePrompt:
			'generic landscape, empty skyline, abstract wallpaper, text overlay, book cover, infographic, diagram, logo, UI, unrelated fantasy imagery',
	};
}

function parseChapter(markdown: string): ChapterContext {
	const lines = markdown.replace(/\r\n/g, '\n').split('\n');
	const headingLine = lines.find((line) => /^#{1,2}\s+/.test(line));

	if (!headingLine) {
		throw new Error('Could not find a markdown heading.');
	}

	const title = stripMarkdown(headingLine.replace(/^#{1,2}\s+/, ''));
	const contentLines = lines.slice(lines.indexOf(headingLine) + 1);
	const blocks: string[] = [];
	let currentBlock: string[] = [];

	for (const line of contentLines) {
		const trimmed = line.trim();

		if (
			trimmed.startsWith('<!--') ||
			trimmed === '<!-- toc -->' ||
			trimmed === '<!-- tocstop -->'
		) {
			continue;
		}

		if (!trimmed) {
			if (currentBlock.length > 0) {
				blocks.push(currentBlock.join(' ').trim());
				currentBlock = [];
			}
			continue;
		}

		if (
			/^#{1,6}\s+/.test(trimmed) ||
			trimmed === '- - - -' ||
			trimmed.startsWith('- [')
		) {
			continue;
		}

		currentBlock.push(trimmed);
	}

	if (currentBlock.length > 0) {
		blocks.push(currentBlock.join(' ').trim());
	}

	const proseBlocks = blocks.filter((block) => !block.startsWith('>'));
	const summarySource = proseBlocks.slice(0, 3).join(' ');
	const summary = truncateAtWord(getSummarySentences(summarySource || title), 420);
	const fullText = truncateAtWord(proseBlocks.join('\n\n') || title, 8000);

	return {
		title,
		summary,
		fullText,
		paragraphs: proseBlocks,
	};
}

async function createVisualBrief(chapter: ChapterContext): Promise<VisualBrief> {
	const fallback = buildDeterministicVisualBrief(chapter);

	if (visualBriefProvider === 'basic') {
		return fallback;
	}

	if (visualBriefProvider === 'lmstudio') {
		try {
			const generator = new LmStudioBriefGenerator();
			return await generator.generate(chapter, fallback);
		} catch (error) {
			console.warn(
				`LM Studio visual brief failed, falling back to deterministic brief: ${(error as Error).message}`
			);
			return fallback;
		}
	}

	throw new Error(
		`Unsupported VISUAL_BRIEF_PROVIDER "${visualBriefProvider}". Use "basic" or "lmstudio".`
	);
}

function buildPrompt(brief: VisualBrief): string {
	return [
		stylePrompt,
		`Chapter title: "${brief.title}".`,
		`Core theme: ${brief.theme}.`,
		`Scene direction: ${brief.visualScene}.`,
		`Short summary: ${brief.summary}.`,
		`Key visual elements: ${brief.keyElements.join(', ')}.`,
		`Mood: ${brief.mood}.`,
		'Composition: strong focal subject, cinematic depth, editorial illustration, and a clear indoor or human-scale environment when relevant.',
		'Do not default to a generic skyline or empty landscape.',
		`Avoid: ${brief.negativePrompt}.`,
		'Format: 16:9 wide horizontal banner.',
	].join(' ');
}

function parseIntegerEnv(name: string, fallback: number): number {
	const raw = process.env[name];

	if (!raw) {
		return fallback;
	}

	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function parseFloatEnv(name: string, fallback: number): number {
	const raw = process.env[name];

	if (!raw) {
		return fallback;
	}

	const parsed = Number.parseFloat(raw);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function createImageProvider(): ImageProvider {
	switch (imageProviderName) {
		case 'comfy':
		case 'comfyui':
			return new ComfyUiProvider({
				width: parseIntegerEnv('COMFYUI_WIDTH', defaultComfyChapterWidth),
				height: parseIntegerEnv('COMFYUI_HEIGHT', defaultComfyChapterHeight),
				steps: parseIntegerEnv('COMFYUI_STEPS', defaultComfyChapterSteps),
				cfg: parseFloatEnv('COMFYUI_CFG', defaultComfyChapterCfg),
				timeoutMs: parseIntegerEnv('COMFYUI_TIMEOUT_MS', defaultComfyChapterTimeoutMs),
			});
		case 'google':
		case 'imagen':
			return new GoogleImagenProvider();
		case 'stability':
		case 'stability-ai':
			return new StabilityAiProvider();
		default:
			throw new Error(
				`Unsupported IMAGE_PROVIDER "${imageProviderName}". Use "comfyui", "google", or "stability".`
			);
	}
}

async function main(): Promise<void> {
	await fs.mkdir(defaultOutputDir, { recursive: true });
	const imageProvider = createImageProvider();

	const fileNames = (await fs.readdir(srcDir))
		.filter((fileName) => fileName.endsWith('.md'))
		.sort((left, right) => left.localeCompare(right));

	let generatedCount = 0;
	let skippedCount = 0;

	for (const fileName of fileNames) {
		const sourcePath = path.join(srcDir, fileName);
		const outputPath = path.join(defaultOutputDir, `${path.parse(fileName).name}.png`);

		if (!force) {
			try {
				await fs.access(outputPath);
				console.log(`skip  ${path.relative(rootDir, outputPath)}`);
				skippedCount += 1;
				continue;
			} catch {
				// File does not exist yet.
			}
		}

		const markdown = await fs.readFile(sourcePath, 'utf8');
		const chapter = parseChapter(markdown);
		const brief = await createVisualBrief(chapter);
		const prompt = buildPrompt(brief);

		if (dryRun) {
			console.log(`plan  ${fileName}`);
			console.log(`      title: ${brief.title}`);
			console.log(`      summary: ${brief.summary}`);
			console.log(`      scene: ${brief.visualScene}`);
			console.log(`      elements: ${brief.keyElements.join(', ')}`);
			console.log(`      output: ${path.relative(rootDir, outputPath)}`);
			if (debugPrompt) {
				console.log(`      prompt: ${prompt}`);
			}
			continue;
		}

		console.log(`make  ${fileName} -> ${path.relative(rootDir, outputPath)}`);
		const imageBuffer = await imageProvider.generate(prompt);
		await fs.writeFile(outputPath, imageBuffer);
		generatedCount += 1;
	}

	if (dryRun) {
		console.log(`dry run complete for ${fileNames.length} chapter files.`);
		return;
	}

	console.log(
		`generated ${generatedCount} image(s), skipped ${skippedCount}, provider ${imageProvider.name}.`
	);
}

main().catch((error: Error) => {
	console.error(error.message);
	process.exitCode = 1;
});
