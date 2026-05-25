import * as fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { marked } from 'marked';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');
const srcDir = path.join(rootDir, 'src');
const templateDir = path.join(rootDir, 'template');
const outputPath = path.join(rootDir, 'index.html');

async function main(): Promise<void> {
	const [beforeHtml, afterHtml, srcFiles] = await Promise.all([
		fs.readFile(path.join(templateDir, 'before.html'), 'utf8'),
		fs.readFile(path.join(templateDir, 'after.html'), 'utf8'),
		fs.readdir(srcDir),
	]);

	const markdownFiles = srcFiles
		.filter((fileName) => fileName.endsWith('.md'))
		.sort((left, right) => left.localeCompare(right));

	const markdownParts = await Promise.all(
		markdownFiles.map((fileName) => fs.readFile(path.join(srcDir, fileName), 'utf8'))
	);

	const markdown = markdownParts.join('');
	const renderedHtml = await marked.parse(markdown);
	const finalHtml = `${beforeHtml}${renderedHtml}${afterHtml}`;

	await fs.writeFile(outputPath, finalHtml);
}

main().catch((error: Error) => {
	console.error(error.message);
	process.exitCode = 1;
});
