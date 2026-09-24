import { toFileUrl } from "@/components/video-editor/projectPersistence";
import {
	collapseTracksToPills,
	placeAudioTrackInDocument,
} from "@/lib/ai-edition/document/audioTracks";
import { createId } from "@/lib/ai-edition/document/ids";
import {
	projectRawTimelineSecToPlayback,
	removeClip,
	withClipsChanged,
} from "@/lib/ai-edition/document/timeline";
import type {
	AxcutAsset,
	AxcutClip,
	AxcutDocument,
	AxcutMediaBoardImage,
	AxcutMediaBoardItem,
} from "@/lib/ai-edition/schema";
import { enqueueDocumentWrite } from "@/lib/ai-edition/store/documentWriteQueue";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { currentWriteEpoch } from "@/lib/ai-edition/store/undoStack";
import {
	CLIP_EFFECTS,
	type ClipEffectId,
	type CreateClipEffectRequest,
	type CreateClipEffectResult,
} from "@/lib/clip-effects/catalog";
import { boardOf, itemDurationSec, resolvedItemEffect, samePath } from "./board";

/**
 * Media's composition onto the timeline. Each item becomes one timeline clip: a clip or video
 * without an effect plays straight from its source; with an effect, or as a photo, it is
 * rendered first — Remotion for an effect, FFmpeg for a still — into a file the project then
 * uses as media. Renders are cached by content in the main process, so applying an unchanged
 * composition again costs nothing but the timeline write.
 */

export type ApplyMode = "replace" | "append";

export interface ApplyProgress {
	done: number;
	total: number;
	label: string;
}

export interface ApplyResult {
	placed: number;
	/** Items whose video or photo is gone from the project. */
	skipped: number;
}

interface Placement {
	assetId: string;
	sourceStartSec: number;
	sourceEndSec: number;
}

export function clipEffectLabel(effect: ClipEffectId): string {
	return CLIP_EFFECTS.find((item) => item.id === effect)?.label ?? "효과 없음";
}

/** What applying will have to render: effect items and photos. The rest is instant. */
export function itemNeedsRender(item: AxcutMediaBoardItem): boolean {
	return item.kind === "image" || resolvedItemEffect(item) !== "none";
}

/**
 * A photo's pixel size, from the file itself; the render keeps its aspect ratio. Null when it
 * cannot be read in time — the render then falls back to a 16:9 frame.
 */
export function readImageSize(
	url: string,
	timeoutMs = 5000,
): Promise<{ width: number; height: number } | null> {
	return new Promise((resolve) => {
		if (typeof Image === "undefined") {
			resolve(null);
			return;
		}
		const image = new Image();
		const timer = setTimeout(() => resolve(null), timeoutMs);
		image.onload = () => {
			clearTimeout(timer);
			resolve(
				image.naturalWidth > 0 && image.naturalHeight > 0
					? { width: image.naturalWidth, height: image.naturalHeight }
					: null,
			);
		};
		image.onerror = () => {
			clearTimeout(timer);
			resolve(null);
		};
		image.src = url;
	});
}

/**
 * The composition laid out on the timeline, pure: `replace` swaps out every clip (the way
 * deleting them one by one would, so what was anchored to them goes too), `append` adds after
 * the last. Audio anchored to a replaced clip would go with it; it is pinned to the programme
 * time it played at instead, the way audio-first tracks already are.
 */
export function placeOnTimeline(
	document: AxcutDocument,
	placements: Placement[],
	mode: ApplyMode,
): AxcutDocument {
	const clips: AxcutClip[] = placements.map((placement) => {
		const length = Math.max(0.001, placement.sourceEndSec - placement.sourceStartSec);
		return {
			id: createId("clip"),
			assetId: placement.assetId,
			sourceStartSec: placement.sourceStartSec,
			sourceEndSec: placement.sourceEndSec,
			timelineStartSec: 0,
			timelineEndSec: length,
			wordRefs: [],
			origin: "user",
			reason: "Media 조합",
		};
	});
	if (mode === "append") return withClipsChanged(document, [...document.timeline.clips, ...clips]);
	let next = pinAudioToProgramme(document);
	for (const clip of next.timeline.clips) next = removeClip(next, clip.id);
	return withClipsChanged(next, clips);
}

function pinAudioToProgramme(document: AxcutDocument): AxcutDocument {
	const { clips, trimRanges } = document.timeline;
	const regions = document.legacyEditor?.speedRegions;
	const speedRegions = Array.isArray(regions)
		? (regions as Array<{ startMs: number; endMs: number; speed: number }>)
		: [];
	const toProgrammeMs = (rawMs: number) =>
		Math.round(
			projectRawTimelineSecToPlayback(clips, trimRanges, rawMs / 1000, speedRegions) * 1000,
		);
	let next = document;
	for (const pill of collapseTracksToPills(document.audioTracks)) {
		if (pill.timelineLocked) continue;
		const startMs = toProgrammeMs(pill.startMs);
		next = placeAudioTrackInDocument(
			next,
			{ ...pill, timelineLocked: true, startMs, endMs: startMs + (pill.endMs - pill.startMs) },
			() => createId("audio"),
			"move",
		);
	}
	return next;
}

let cancelRequested = false;

/** Stops an apply after the item it is rendering; nothing is placed. */
export function cancelApply(): void {
	cancelRequested = true;
}

/**
 * Renders what needs rendering and places the whole composition, as one undoable timeline
 * edit. Resolves null when nothing was placed: an empty composition, a cancel, or a project
 * switch or undo while it rendered.
 */
export async function applyComposition(
	mode: ApplyMode,
	onProgress: (progress: ApplyProgress) => void = () => undefined,
): Promise<ApplyResult | null> {
	const start = useProjectStore.getState();
	const projectId = start.projectId;
	const document = start.document;
	if (!projectId || !document) return null;
	const items = boardOf(document).items;
	if (items.length === 0) return null;
	cancelRequested = false;
	const epoch = currentWriteEpoch();
	const superseded = () =>
		cancelRequested ||
		useProjectStore.getState().projectId !== projectId ||
		currentWriteEpoch() !== epoch;

	const toRender = items.filter(itemNeedsRender).length;
	let rendered = 0;
	let skipped = 0;
	const placements: Placement[] = [];
	for (const item of items) {
		if (superseded()) return null;
		const current = useProjectStore.getState().document ?? document;
		if (itemNeedsRender(item))
			onProgress({ done: rendered, total: toRender, label: item.label || "클립" });
		const placement = await placeItem(item, current, superseded);
		if (superseded()) return null;
		if (itemNeedsRender(item)) rendered++;
		if (placement) placements.push(placement);
		else skipped++;
	}
	onProgress({ done: rendered, total: toRender, label: "" });
	if (placements.length === 0) return { placed: 0, skipped };
	const saved = await enqueueDocumentWrite(async () => {
		if (superseded()) return false;
		const state = useProjectStore.getState();
		if (!state.document) return false;
		return state.saveDocument(placeOnTimeline(state.document, placements, mode), {
			history: true,
		});
	});
	return saved ? { placed: placements.length, skipped } : null;
}

async function placeItem(
	item: AxcutMediaBoardItem,
	document: AxcutDocument,
	superseded: () => boolean,
): Promise<Placement | null> {
	const effect = resolvedItemEffect(item);
	const durationSec = itemDurationSec(item);
	if (item.kind === "image") {
		const image = boardOf(document).images.find((entry) => entry.id === item.imageId);
		if (!image) return null;
		const result =
			effect === "none"
				? await convertImage(image, durationSec)
				: await renderEffect({
						sourcePath: image.path,
						sourceKind: "image",
						startMs: 0,
						endMs: Math.round(durationSec * 1000),
						effect,
						...(await imageDimensions(image)),
					});
		return mediaPlacement(
			result,
			`${item.label} · ${clipEffectLabel(effect)}`,
			durationSec,
			superseded,
		);
	}
	const asset = document.assets.find((entry) => entry.id === item.assetId);
	if (!asset) return null;
	if (effect === "none")
		return { assetId: asset.id, sourceStartSec: item.startSec, sourceEndSec: item.endSec };
	const result = await renderEffect({
		sourcePath: asset.originalPath,
		startMs: Math.round(item.startSec * 1000),
		endMs: Math.round(item.endSec * 1000),
		effect,
		...(await videoDimensions(asset)),
	});
	return mediaPlacement(
		result,
		`${item.label} · ${item.startSec.toFixed(1)}–${item.endSec.toFixed(1)}초 · ${clipEffectLabel(effect)}`,
		durationSec,
		superseded,
	);
}

async function renderEffect(request: CreateClipEffectRequest): Promise<CreateClipEffectResult> {
	const create = window.electronAPI?.createClipEffect;
	if (!create) throw new Error("효과 렌더링은 Donqui Studio 데스크톱 앱에서 사용할 수 있습니다.");
	const result = await create(request);
	if (!result.success || !result.filePath)
		throw new Error(result.error || "효과를 적용한 클립을 만들지 못했습니다.");
	return result;
}

async function convertImage(
	image: AxcutMediaBoardImage,
	durationSec: number,
): Promise<CreateClipEffectResult> {
	const create = window.electronAPI?.createImageClip;
	if (!create) throw new Error("사진 클립은 Donqui Studio 데스크톱 앱에서 사용할 수 있습니다.");
	const result = await create(image.path, durationSec);
	if (!result.success || !result.filePath)
		throw new Error(result.error || `${image.label} 사진을 클립으로 만들지 못했습니다.`);
	return result;
}

async function videoDimensions(asset: AxcutAsset): Promise<{ width: number; height: number }> {
	if (asset.video?.width && asset.video.height)
		return { width: asset.video.width, height: asset.video.height };
	// Camera footage the browser cannot open still has a size FFmpeg can read.
	const probe = await window.electronAPI?.vclipProbe?.(asset.originalPath).catch(() => null);
	if (probe?.success && probe.width && probe.height)
		return { width: probe.width, height: probe.height };
	return { width: 1920, height: 1080 };
}

async function imageDimensions(
	image: AxcutMediaBoardImage,
): Promise<{ width: number; height: number }> {
	if (image.width && image.height) return { width: image.width, height: image.height };
	return (await readImageSize(toFileUrl(image.path))) ?? { width: 1920, height: 1080 };
}

/**
 * The rendered file as project media — the asset already pointing at it when there is one, so
 * applying twice does not list the same render twice — played whole.
 */
async function mediaPlacement(
	result: CreateClipEffectResult,
	label: string,
	expectedSec: number,
	superseded: () => boolean,
): Promise<Placement | null> {
	const filePath = result.filePath;
	if (!filePath || superseded()) return null;
	const durationSec = result.durationMs ? result.durationMs / 1000 : expectedSec;
	const existing = useProjectStore
		.getState()
		.document?.assets.find((asset) => samePath(asset.originalPath, filePath));
	if (existing)
		return {
			assetId: existing.id,
			sourceStartSec: 0,
			sourceEndSec: existing.durationSec || durationSec,
		};
	const created = await useProjectStore.getState().addAsset(filePath, label);
	if (!created || superseded()) return null;
	await enqueueDocumentWrite(async () => {
		if (superseded()) return false;
		const state = useProjectStore.getState();
		if (!state.document?.assets.some((asset) => asset.id === created.id)) return false;
		return state.saveDocument(
			{
				...state.document,
				assets: state.document.assets.map((asset) =>
					asset.id === created.id
						? {
								...asset,
								durationSec,
								video: {
									codec: "h264",
									fps: 30,
									width: result.width ?? asset.video?.width ?? 0,
									height: result.height ?? asset.video?.height ?? 0,
								},
							}
						: asset,
				),
			},
			{ history: false },
		);
	});
	return { assetId: created.id, sourceStartSec: 0, sourceEndSec: durationSec };
}
