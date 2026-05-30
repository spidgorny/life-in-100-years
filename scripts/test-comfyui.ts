#!/usr/bin/env node

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ComfyUiProvider } from './image-providers/comfyui-provider.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');
const defaultOutputPath = path.join(rootDir, 'images', 'test', 'comfyui-smoke.png');
const defaultPrompt = 'a single red apple on a wooden table, realistic photo, soft light, plain background';

interface ParsedArgs {
	outputPath: string;
	prompt: string;
}

function parseArgs(argv: string[]): ParsedArgs {
	let outputPath = process.env.COMFYUI_TEST_OUTPUT || defaultOutputPath;
	let prompt = process.env.COMFYUI_TEST_PROMPT || defaultPrompt;

	for (let index = 0; index < argv.length; index += 1) {
		const current = argv[index];

		if ((current === '--output' || current === '-o') && argv[index + 1]) {
			outputPath = path.resolve(argv[index + 1]);
			index += 1;
			continue;
		}

		if ((current === '--prompt' || current === '-p') && argv[index + 1]) {
			prompt = argv[index + 1];
			index += 1;
		}
	}

	return { outputPath, prompt };
}

async function main(): Promise<void> {
	const { outputPath, prompt } = parseArgs(process.argv.slice(2));
	const width = Number.parseInt(process.env.COMFYUI_TEST_WIDTH || '512', 10);
	const height = Number.parseInt(process.env.COMFYUI_TEST_HEIGHT || '512', 10);
	const steps = Number.parseInt(process.env.COMFYUI_TEST_STEPS || '8', 10);
	const timeoutMs = Number.parseInt(process.env.COMFYUI_TEST_TIMEOUT_MS || '120000', 10);
	const startedAt = Date.now();

	const provider = new ComfyUiProvider({
		width,
		height,
		steps,
		cfg: Number.parseFloat(process.env.COMFYUI_TEST_CFG || '5'),
		filenamePrefix: process.env.COMFYUI_TEST_FILENAME_PREFIX || 'comfyui-smoke-test',
		timeoutMs,
	});

	console.log(`ComfyUI base URL: ${process.env.COMFYUI_BASE_URL || 'http://127.0.0.1:8188'}`);
	console.log(`Checkpoint: ${process.env.COMFYUI_CHECKPOINT_NAME || 'sd_xl_base_1.0.safetensors'}`);
	console.log(`Generating ${width}x${height} test image with ${steps} steps...`);
	console.log(`Prompt: ${prompt}`);

	const image = await provider.generate(prompt);
	await fs.mkdir(path.dirname(outputPath), { recursive: true });
	await fs.writeFile(outputPath, image);

	const elapsedMs = Date.now() - startedAt;
	console.log(`Saved test image to ${outputPath} in ${elapsedMs}ms`);
}

main().catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(message);
	process.exitCode = 1;
});
