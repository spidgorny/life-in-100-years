import * as fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { marked } from 'marked';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');
const srcDir = path.join(rootDir, 'src');
const chapterImagesDir = path.join(rootDir, 'images', 'chapters');
const templateDir = path.join(rootDir, 'template');
const outputPath = path.join(rootDir, 'index.html');

function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;');
}

function getFirstHeading(markdown: string): string | null {
	const match = markdown.match(/^#{1,6}\s+(.+)$/m);

	if (!match) {
		return null;
	}

	return match[1].trim();
}

async function buildChapterHtml(fileName: string): Promise<string> {
	const markdown = await fs.readFile(path.join(srcDir, fileName), 'utf8');
	const renderedHtml = String(await marked.parse(markdown));
	const chapterName = path.basename(fileName, '.md');
	const imagePath = path.join(chapterImagesDir, `${chapterName}.png`);

	try {
		await fs.access(imagePath);
	} catch {
		return renderedHtml;
	}

	const heading = getFirstHeading(markdown) ?? chapterName;
	const imageHtml = `<p><img src="images/chapters/${chapterName}.png" alt="${escapeHtml(heading)}" loading="lazy"></p>`;

	return renderedHtml.replace(/(<h[1-6][^>]*>.*?<\/h[1-6]>)/s, `$1\n${imageHtml}`);
}

async function main(): Promise<void> {
	const [beforeHtml, afterHtml, srcFiles] = await Promise.all([
		fs.readFile(path.join(templateDir, 'before.html'), 'utf8'),
		fs.readFile(path.join(templateDir, 'after.html'), 'utf8'),
		fs.readdir(srcDir),
	]);

	const markdownFiles = srcFiles
		.filter((fileName) => fileName.endsWith('.md'))
		.sort((left, right) => left.localeCompare(right));

	const renderedParts = await Promise.all(markdownFiles.map((fileName) => buildChapterHtml(fileName)));
	const renderedHtml = renderedParts.join('\n');
	const finalHtml = `${beforeHtml}${renderedHtml}${afterHtml}`;

	await fs.writeFile(outputPath, finalHtml);
}

main().catch((error: Error) => {
	console.error(error.message);
	process.exitCode = 1;
});
