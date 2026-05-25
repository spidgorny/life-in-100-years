# Copilot Instructions

## Build, validation, and content-generation commands

- `npm run make:readme` — concatenate `src/*.md` into `readme.md` and refresh the Markdown TOC.
- `npm run make:html` — rebuild `index.html` from `src/*.md` via `scripts/build-html.ts` and `template/before.html` + `template/after.html`.
- `npm run typecheck` — type-check the TypeScript automation scripts under `scripts/**/*.ts`.
- `npm run generate:images -- --dry-run` — preview chapter image generation without calling external providers.
- `npm run generate:images -- --force` — regenerate chapter images even if `images/chapters/*.png` already exist.

There is no automated test runner or lint command configured in `package.json`. The main validation loop is rebuilding the generated manuscript outputs and running `npm run typecheck`.

## High-level architecture

### Manuscript source of truth

- The book is authored in `src/*.md`. File names use zero-padded numeric prefixes (`110-...`, `120-...`) and are assembled in lexical order.
- `readme.md` and `index.html` are generated artifacts, not primary authoring targets.
- `npm run make:readme` concatenates the chapter files and refreshes the TOC in `readme.md`.
- `npm run make:html` uses `scripts/build-html.ts` to read all chapter files, render them with `marked`, and wrap the result with the static HTML shell in `template/`.

### Image-generation pipeline

- `scripts/generate-chapter-images.ts` is the entry point for chapter banner generation.
- That script reads each chapter from `src/`, parses it into a `ChapterContext`, creates a `VisualBrief`, builds the final prompt, and writes the image to `images/chapters/<chapter-basename>.png`.
- Visual-brief generation has two layers:
  - deterministic fallback logic in `generate-chapter-images.ts`
  - optional LM Studio refinement in `scripts/visual-briefs/lm-studio-brief-generator.ts`
- Final image generation is provider-based through the `ImageProvider` interface in `scripts/image-providers/image-provider.ts`.
  - `ComfyUiProvider` is the default provider
  - `StabilityAiProvider` and `GoogleImagenProvider` are alternative adapters
- API request/response debugging for all providers is centralized in `scripts/image-providers/api-debug.ts`.

## Key repository conventions

- When changing book content, edit `src/*.md` and regenerate `readme.md` and `index.html`. Do not hand-edit generated output files unless the task is specifically about the build pipeline.
- Preserve the numeric filename prefixes in `src/`. They control chapter order in the assembled book and also determine the output image names in `images/chapters/`.
- The repo’s automation scripts are TypeScript ESM with `moduleResolution: "NodeNext"`. In `scripts/**/*.ts`, keep `.js` import specifiers and use `import.meta.url`/`fileURLToPath` instead of `__dirname`.
- The image prompt pipeline is intentionally biased toward concrete, human-scale scenes rather than generic skylines or landscapes. If you adjust prompt generation, keep that constraint intact across the deterministic brief, LM Studio brief, and provider prompts.
- Provider selection is driven by environment variables rather than code changes:
  - `IMAGE_PROVIDER=comfyui|stability|google`
  - `VISUAL_BRIEF_PROVIDER=basic|lmstudio`
- Extra HTTP diagnostics are opt-in via `IMAGE_API_DEBUG=1` or `DEBUG_IMAGE_API=1`.
- The pre-commit hook regenerates `readme.md` and `index.html`, so content edits should leave those generated files in sync before committing.
