import {
	collapseTracksToPills,
	resolveFadeSecs,
	trackGroupId,
} from "@/lib/ai-edition/document/audioTracks";
import { createId } from "@/lib/ai-edition/document/ids";
import { setWordText } from "@/lib/ai-edition/document/transcript";
import {
	type AxcutAudioBoard,
	type AxcutAudioBoardLayer,
	type AxcutAudioTrack,
	type AxcutDocument,
	type AxcutTranscript,
	createAudioTrack,
} from "@/lib/ai-edition/schema";
import { findAssetTranscript } from "@/lib/ai-edition/transcription/status";

/**
 * The Audio tab's board. Music and narration files are LAYERS, each on its own row: where it
 * starts, which stretch of its file it plays, how loud, and its fades. Applying the board mixes
 * the layers into one file, and the programme plays that MIX as its only audio track — which is
 * what Media fits its composition to. Pure operations; the store writes them.
 */

/** The shortest stretch of a file a layer can play. */
export const MIN_LAYER_SEC = 0.1;
/** Volume is a percentage of the file's own level; 400% is the old +12 dB ceiling. */
export const MAX_VOLUME = 400;
export const MIX_LABEL = "오디오 믹스";

export type LayerKind = AxcutAudioBoardLayer["kind"];

export type LayerPatch = Partial<
	Pick<
		AxcutAudioBoardLayer,
		| "kind"
		| "label"
		| "startSec"
		| "inSec"
		| "outSec"
		| "volume"
		| "fadeInSec"
		| "fadeOutSec"
		| "muted"
	>
>;

const round3 = (value: number) => Math.round(value * 1000) / 1000;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

export function audioBoardOf(document: AxcutDocument | null): AxcutAudioBoard {
	return document?.audioBoard ?? { layers: [] };
}

function withBoard(document: AxcutDocument, board: AxcutAudioBoard): AxcutDocument {
	return { ...document, audioBoard: board };
}

export const layerSpanSec = (layer: AxcutAudioBoardLayer) =>
	Math.max(0, layer.outSec - layer.inSec);
export const layerEndSec = (layer: AxcutAudioBoardLayer) => layer.startSec + layerSpanSec(layer);
export const isAudible = (layer: AxcutAudioBoardLayer) =>
	!layer.muted && layer.volume > 0 && layerSpanSec(layer) > 0;

/** Where the last layer ends — what the board's timeline has to show. */
export function boardEndSec(layers: AxcutAudioBoardLayer[]): number {
	return layers.reduce((end, layer) => Math.max(end, layerEndSec(layer)), 0);
}

/** How long the mix runs: to the end of the last layer that makes a sound. */
export function mixDurationSec(layers: AxcutAudioBoardLayer[]): number {
	return round3(boardEndSec(layers.filter(isAudible)));
}

/** A dB gain as the percentage the Audio tab shows: 0 dB is 100%, -6 dB about 50%. */
export function volumeFromGainDb(gainDb: number): number {
	return clampVolume(100 * 10 ** (gainDb / 20));
}

export function clampVolume(volume: number): number {
	return Number.isFinite(volume) ? clamp(Math.round(volume), 0, MAX_VOLUME) : 100;
}

export function layerLabel(document: AxcutDocument | null, layer: AxcutAudioBoardLayer): string {
	return (
		layer.label ||
		document?.assets.find((asset) => asset.id === layer.assetId)?.label ||
		(layer.kind === "music" ? "음악" : "나레이션")
	);
}

export interface LayerDraft {
	assetId: string;
	kind: LayerKind;
	label: string;
	durationSec: number;
}

/**
 * New layers play whole, each on its own row, one after another after the last layer of their
 * kind: narrations imported together line up in order, and so do songs.
 */
export function addLayers(
	document: AxcutDocument,
	drafts: LayerDraft[],
): { document: AxcutDocument; ids: string[] } {
	const board = audioBoardOf(document);
	const layers = [...board.layers];
	const ids: string[] = [];
	for (const draft of drafts) {
		if (!(draft.durationSec > 0)) continue;
		const startSec = boardEndSec(layers.filter((layer) => layer.kind === draft.kind));
		const layer: AxcutAudioBoardLayer = {
			id: createId("layer"),
			assetId: draft.assetId,
			kind: draft.kind,
			label: draft.label,
			startSec: round3(startSec),
			inSec: 0,
			outSec: round3(draft.durationSec),
			volume: 100,
			fadeInSec: 0,
			fadeOutSec: 0,
			muted: false,
		};
		layers.push(layer);
		ids.push(layer.id);
	}
	if (ids.length === 0) return { document, ids };
	return { document: withBoard(document, { ...board, layers }), ids };
}

/** `patch` applied and kept playable: inside its file, at least MIN_LAYER_SEC, fades inside it. */
export function normalizedLayer(
	layer: AxcutAudioBoardLayer,
	patch: LayerPatch,
	sourceDurationSec?: number,
): AxcutAudioBoardLayer {
	const next = { ...layer, ...patch };
	const finite = (value: number, fallback: number) => (Number.isFinite(value) ? value : fallback);
	const limit =
		sourceDurationSec && sourceDurationSec > 0 ? sourceDurationSec : Number.POSITIVE_INFINITY;
	const inSec = clamp(finite(next.inSec, layer.inSec), 0, Math.max(0, limit - MIN_LAYER_SEC));
	const outSec = clamp(finite(next.outSec, layer.outSec), inSec + MIN_LAYER_SEC, limit);
	const span = outSec - inSec;
	return {
		...next,
		startSec: round3(Math.max(0, finite(next.startSec, layer.startSec))),
		inSec: round3(inSec),
		outSec: round3(outSec),
		volume: clampVolume(finite(next.volume, layer.volume)),
		fadeInSec: round3(clamp(finite(next.fadeInSec, layer.fadeInSec), 0, span)),
		fadeOutSec: round3(clamp(finite(next.fadeOutSec, layer.fadeOutSec), 0, span)),
	};
}

const LAYER_FIELDS = [
	"kind",
	"label",
	"startSec",
	"inSec",
	"outSec",
	"volume",
	"fadeInSec",
	"fadeOutSec",
	"muted",
] as const;

export function updateLayer(document: AxcutDocument, id: string, patch: LayerPatch): AxcutDocument {
	const board = audioBoardOf(document);
	const layer = board.layers.find((entry) => entry.id === id);
	if (!layer) return document;
	const source = document.assets.find((asset) => asset.id === layer.assetId)?.durationSec;
	const next = normalizedLayer(layer, patch, source);
	if (LAYER_FIELDS.every((field) => next[field] === layer[field])) return document;
	return withBoard(document, {
		...board,
		layers: board.layers.map((entry) => (entry.id === id ? next : entry)),
	});
}

export function removeLayer(document: AxcutDocument, id: string): AxcutDocument {
	const board = audioBoardOf(document);
	const layer = board.layers.find((entry) => entry.id === id);
	if (!layer) return document;
	const next = withBoard(document, {
		...board,
		layers: board.layers.filter((entry) => entry.id !== id),
	});
	return dropOrphanAudio(next, [layer.assetId]);
}

/**
 * Drops the given audio assets, with their transcripts, once nothing plays or holds them: an
 * imported audio file is reachable only through a layer or a track.
 */
function dropOrphanAudio(document: AxcutDocument, assetIds: string[]): AxcutDocument {
	const board = audioBoardOf(document);
	const held = new Set([
		...document.timeline.clips.map((clip) => clip.assetId),
		...document.audioTracks.map((track) => track.assetId),
		...board.layers.map((layer) => layer.assetId),
		...(board.mix ? [board.mix.assetId] : []),
	]);
	const doomed = new Set(
		assetIds.filter(
			(id) =>
				!held.has(id) && document.assets.some((asset) => asset.id === id && asset.kind === "audio"),
		),
	);
	if (doomed.size === 0) return document;
	return {
		...document,
		assets: document.assets.filter((asset) => !doomed.has(asset.id)),
		transcripts: document.transcripts.filter((transcript) => !doomed.has(transcript.assetId)),
	};
}

/**
 * Every programme audio track not yet on the board becomes a layer, so what the programme plays
 * is what the Audio tab shows before anything is mixed. The applied mix is not a layer, and a
 * track is taken only once.
 */
export function adoptProgrammeTracks(document: AxcutDocument): AxcutDocument {
	const board = audioBoardOf(document);
	const taken = new Set(board.layers.map((layer) => layer.trackId));
	const pills = collapseTracksToPills(document.audioTracks).filter(
		(pill) => pill.assetId !== board.mix?.assetId && !taken.has(trackGroupId(pill)),
	);
	if (pills.length === 0) return document;
	const adopted = pills.map((pill): AxcutAudioBoardLayer => {
		const asset = document.assets.find((entry) => entry.id === pill.assetId);
		const inSec = pill.offsetMs / 1000;
		const spanSec = Math.max(MIN_LAYER_SEC, (pill.endMs - pill.startMs) / 1000);
		const sourceSec = asset?.durationSec || pill.durationSec || inSec + spanSec;
		return {
			id: createId("layer"),
			assetId: pill.assetId,
			kind: pill.kind,
			label: pill.label || asset?.label || "",
			startSec: round3(pill.startMs / 1000),
			inSec: round3(inSec),
			outSec: round3(Math.max(inSec + MIN_LAYER_SEC, Math.min(sourceSec, inSec + spanSec))),
			volume: volumeFromGainDb(pill.gainDb),
			fadeInSec: round3(pill.fadeInMs / 1000),
			fadeOutSec: round3(pill.fadeOutMs / 1000),
			muted: pill.muted,
			trackId: trackGroupId(pill),
		};
	});
	return withBoard(document, { ...board, layers: [...board.layers, ...adopted] });
}

export interface MixLayerSpec {
	path: string;
	startSec: number;
	inSec: number;
	outSec: number;
	/** Linear: volume / 100. */
	gain: number;
	fadeInSec: number;
	fadeOutSec: number;
}

export interface MixSpec {
	layers: MixLayerSpec[];
	durationSec: number;
}

/** What the mixer is asked for: every layer that makes a sound, by its file. Null when none does. */
export function mixSpec(document: AxcutDocument | null): MixSpec | null {
	if (!document) return null;
	const layers: MixLayerSpec[] = [];
	for (const layer of audioBoardOf(document).layers.filter(isAudible)) {
		const asset = document.assets.find((entry) => entry.id === layer.assetId);
		if (!asset) continue;
		// Fades that overrun the layer share it in proportion, as they do everywhere else.
		const fades = resolveFadeSecs(
			layer.fadeInSec * 1000,
			layer.fadeOutSec * 1000,
			layerSpanSec(layer),
		);
		layers.push({
			path: asset.originalPath,
			startSec: layer.startSec,
			inSec: layer.inSec,
			outSec: layer.outSec,
			gain: layer.volume / 100,
			fadeInSec: round3(fades.fadeInSec),
			fadeOutSec: round3(fades.fadeOutSec),
		});
	}
	if (layers.length === 0) return null;
	const durationSec = round3(
		Math.max(...layers.map((layer) => layer.startSec + layer.outSec - layer.inSec)),
	);
	return { layers, durationSec };
}

/** What a mix was made from, as a string: equal strings, the same sound. */
export function mixSignature(spec: MixSpec | null): string {
	return spec ? JSON.stringify(spec) : "";
}

export type MixStatus = "empty" | "unapplied" | "changed" | "applied";

/**
 * `empty`: no layer makes a sound. `unapplied`: the programme does not play the board's mix.
 * `changed`: it does, but the layers changed since. `applied`: it plays exactly these layers.
 */
export function mixStatus(document: AxcutDocument | null): MixStatus {
	const spec = mixSpec(document);
	if (!document || !spec) return "empty";
	const mix = audioBoardOf(document).mix;
	if (!mix || !document.audioTracks.some((track) => track.assetId === mix.assetId))
		return "unapplied";
	return mix.signature === mixSignature(spec) ? "applied" : "changed";
}

/** True when the programme's audio is the board's mix. */
export function playsBoardMix(document: AxcutDocument | null): boolean {
	const mix = audioBoardOf(document).mix;
	return Boolean(mix && document?.audioTracks.some((track) => track.assetId === mix.assetId));
}

export interface AppliedMix {
	assetId: string;
	durationSec: number;
	signature: string;
}

/**
 * The programme plays the mix alone, from 0 and on the programme clock, in one edit. A mix with
 * narration in it is narration to the rest of the app — captions and Media's cuts on pauses read
 * it — so it carries the narration layers' words where it plays them. Tracks the board had not
 * taken yet are taken first, so nothing the programme played goes missing unseen.
 */
export function applyMix(document: AxcutDocument, mix: AppliedMix): AxcutDocument {
	const adopted = adoptProgrammeTracks(document);
	const board = audioBoardOf(adopted);
	const narration = board.layers.some((layer) => layer.kind === "voiceover" && isAudible(layer));
	const track: AxcutAudioTrack = {
		...createAudioTrack({
			assetId: mix.assetId,
			durationSec: mix.durationSec,
			kind: narration ? "voiceover" : "music",
			label: MIX_LABEL,
		}),
		timelineLocked: true,
	};
	const replaced = [
		...adopted.audioTracks.map((entry) => entry.assetId),
		...(board.mix ? [board.mix.assetId] : []),
	].filter((id) => id !== mix.assetId);
	const next = withMixTranscript(
		withBoard(
			{ ...adopted, audioTracks: [track] },
			{ ...board, mix: { assetId: mix.assetId, signature: mix.signature } },
		),
		mix.assetId,
		board.mix?.assetId,
	);
	return dropOrphanAudio(next, replaced);
}

/**
 * The narration layers' words where the mix plays them. Only when every narration layer that
 * makes a sound has its transcript; otherwise the mix is left to be transcribed like any
 * narration, and a transcript it already has is kept. A word corrected on the previous mix keeps
 * its correction: its id names the layer and the word, which a new mix of them names again.
 */
function withMixTranscript(
	document: AxcutDocument,
	mixAssetId: string,
	previousAssetId: string | undefined,
): AxcutDocument {
	const layers = audioBoardOf(document).layers.filter(
		(layer) => layer.kind === "voiceover" && isAudible(layer),
	);
	const sources = layers.map((layer) => ({
		layer,
		transcript: findAssetTranscript(document, layer.assetId),
	}));
	if (sources.length === 0 || sources.some((source) => !source.transcript)) return document;
	const words: AxcutTranscript["words"] = [];
	const segments: AxcutTranscript["segments"] = [];
	let language = "";
	for (const { layer, transcript } of sources) {
		if (!transcript) continue;
		language ||= transcript.language;
		const shift = layer.startSec - layer.inSec;
		const plays = (start: number, end: number) => end > layer.inSec && start < layer.outSec;
		const toMix = (sec: number) => round3(clamp(sec + shift, layer.startSec, layerEndSec(layer)));
		const prefix = `${layer.id}:`;
		const kept = new Set<string>();
		for (const word of transcript.words) {
			if (!plays(word.startSec, word.endSec)) continue;
			kept.add(word.id);
			words.push({
				...word,
				id: prefix + word.id,
				segmentId: prefix + word.segmentId,
				startSec: toMix(word.startSec),
				endSec: toMix(word.endSec),
			});
		}
		for (const segment of transcript.segments) {
			if (!plays(segment.startSec, segment.endSec)) continue;
			segments.push({
				...segment,
				id: prefix + segment.id,
				startSec: toMix(segment.startSec),
				endSec: toMix(segment.endSec),
				wordIds: segment.wordIds.filter((id) => kept.has(id)).map((id) => prefix + id),
			});
		}
	}
	const byStart = (left: { startSec: number }, right: { startSec: number }) =>
		left.startSec - right.startSec;
	let transcript: AxcutTranscript = {
		assetId: mixAssetId,
		language: language || "auto",
		segments: segments.sort(byStart),
		words: words.sort(byStart),
	};
	const previous = previousAssetId ? findAssetTranscript(document, previousAssetId) : null;
	for (const edit of previous?.words ?? []) {
		if (edit.source !== "user" || !transcript.words.some((word) => word.id === edit.id)) continue;
		try {
			transcript = setWordText(transcript, edit.id, edit.text);
		} catch {
			// A word whose segment no longer holds it together keeps the narration's text.
		}
	}
	return {
		...document,
		transcripts: [
			...document.transcripts.filter((entry) => entry.assetId !== mixAssetId),
			transcript,
		],
	};
}

/**
 * A layer as the audio track the preview's player already knows how to play: its span, its
 * offset into the file and its fades. The layer's volume is applied by the caller.
 */
export function layerAsTrack(
	layer: AxcutAudioBoardLayer,
	sourceDurationSec: number | undefined,
): AxcutAudioTrack {
	return {
		id: layer.id,
		assetId: layer.assetId,
		kind: layer.kind,
		startMs: Math.round(layer.startSec * 1000),
		endMs: Math.round(layerEndSec(layer) * 1000),
		offsetMs: Math.round(layer.inSec * 1000),
		durationSec: sourceDurationSec ?? layer.outSec,
		gainDb: 0,
		loop: false,
		fadeInMs: Math.round(layer.fadeInSec * 1000),
		fadeOutMs: Math.round(layer.fadeOutSec * 1000),
		muted: layer.muted,
		label: layer.label,
		origin: "user",
	};
}
