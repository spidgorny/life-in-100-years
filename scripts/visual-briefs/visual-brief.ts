export interface ChapterContext {
	title: string;
	summary: string;
	fullText: string;
	paragraphs: string[];
}

export interface VisualBrief {
	title: string;
	summary: string;
	theme: string;
	visualScene: string;
	keyElements: string[];
	mood: string;
	negativePrompt: string;
}
