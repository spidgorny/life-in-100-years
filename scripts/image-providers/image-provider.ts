export interface ImageProvider {
	readonly name: string;
	generate(prompt: string): Promise<Buffer>;
}
