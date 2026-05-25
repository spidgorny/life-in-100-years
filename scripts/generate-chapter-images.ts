#!/usr/bin/env node

import * as fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { GoogleImagenProvider } from './image-providers/google-imagen-provider.js';
import type { ImageProvider } from './image-providers/image-provider.js';
import { StabilityAiProvider } from './image-providers/stability-ai-provider.js';

interface Chapter {
	title: string;
	summary: string;
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');
const srcDir = path.join(rootDir, 'src');
const defaultOutputDir = path.join(rootDir, 'images', 'chapters');
const imageProviderName = (process.env.IMAGE_PROVIDER || 'stability').toLowerCase();

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
	return sentences.slice(0, 2).join(' ').trim() || normalized;
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

function parseChapter(markdown: string): Chapter {
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

	const summaryBlock = blocks.find((block) => !block.startsWith('>')) || blocks[0] || title;
	const summary = truncateAtWord(getSummarySentences(summaryBlock), 280);

	return { title, summary };
}

function buildPrompt({ title, summary }: Chapter): string {
	return [
		stylePrompt,
		`Chapter title: "${title}".`,
		`Short summary: ${summary}.`,
		'Format: 16:9 wide horizontal banner.',
	].join(' ');
}

function createImageProvider(): ImageProvider {
	switch (imageProviderName) {
		case 'google':
		case 'imagen':
			return new GoogleImagenProvider();
		case 'stability':
		case 'stability-ai':
			return new StabilityAiProvider();
		default:
			throw new Error(
				`Unsupported IMAGE_PROVIDER "${imageProviderName}". Use "google" or "stability".`
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
		const prompt = buildPrompt(chapter);

		if (dryRun) {
			console.log(`plan  ${fileName}`);
			console.log(`      title: ${chapter.title}`);
			console.log(`      summary: ${chapter.summary}`);
			console.log(`      output: ${path.relative(rootDir, outputPath)}`);
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
