import { describe, expect, it } from "vitest";
import {
	type AxcutAsset,
	type AxcutDocument,
	type AxcutTranscript,
	createAudioTrack,
	createEmptyDocument,
	documentSchema,
} from "@/lib/ai-edition/schema";
import {
	addLayers,
	adoptProgrammeTracks,
	applyMix,
	audioBoardOf,
	layerAsTrack,
	mixDurationSec,
	mixSignature,
	mixSpec,
	mixStatus,
	normalizedLayer,
	playsBoardMix,
	removeLayer,
	updateLayer,
	volumeFromGainDb,
} from "./board";

const audio = (id: string, durationSec: number): AxcutAsset => ({
	id,
	kind: "audio",
	label: `${id}.mp3`,
	originalPath: `C:/audio/${id}.mp3`,
	durationSec,
	cameraTrack: null,
});
const song = audio("song", 30);
const intro = audio("intro", 6);
const outro = audio("outro", 4);

function base(): AxcutDocument {
	return {
		...createEmptyDocument({ projectId: "p", title: "Audio" }),
		assets: [song, intro, outro],
	};
}

/** A song and two narrations, as the Audio tab imports them. */
function withLayers() {
	const music = addLayers(base(), [
		{ assetId: "song", kind: "music", label: "song", durationSec: 30 },
	]);
	return addLayers(music.document, [
		{ assetId: "intro", kind: "voiceover", label: "intro", durationSec: 6 },
		{ assetId: "outro", kind: "voiceover", label: "outro", durationSec: 4 },
	]).document;
}

const layerOf = (document: AxcutDocument, assetId: string) => {
	const layer = audioBoardOf(document).layers.find((entry) => entry.assetId === assetId);
	if (!layer) throw new Error(`no layer for ${assetId}`);
	return layer;
};

describe("layers", () => {
	it("play whole, each on its row, lined up after the last of their kind", () => {
		const document = withLayers();
		expect(
			audioBoardOf(document).layers.map((layer) => [layer.assetId, layer.startSec, layer.outSec]),
		).toEqual([
			["song", 0, 30],
			["intro", 0, 6],
			["outro", 6, 4],
		]);
		expect(layerOf(document, "outro")).toMatchObject({ inSec: 0, volume: 100, muted: false });
		expect(documentSchema.parse(document).audioBoard?.layers).toHaveLength(3);
	});

	it("are kept inside their file and at least a tenth of a second long", () => {
		const layer = layerOf(withLayers(), "intro");
		expect(normalizedLayer(layer, { outSec: 60 }, 6)).toMatchObject({ outSec: 6 });
		expect(normalizedLayer(layer, { inSec: 5.99 }, 6)).toMatchObject({ inSec: 5.9, outSec: 6 });
		expect(normalizedLayer(layer, { startSec: -3, volume: 999 }, 6)).toMatchObject({
			startSec: 0,
			volume: 400,
		});
		expect(normalizedLayer(layer, { fadeInSec: 10, volume: 42.6 }, 6)).toMatchObject({
			fadeInSec: 6,
			volume: 43,
		});
	});

	it("change one at a time, and an edit that changes nothing is no edit", () => {
		const document = withLayers();
		const id = layerOf(document, "song").id;
		const quieter = updateLayer(document, id, { volume: 35 });
		expect(layerOf(quieter, "song").volume).toBe(35);
		expect(updateLayer(quieter, id, { volume: 35 })).toBe(quieter);
		expect(updateLayer(document, "missing", { volume: 1 })).toBe(document);
	});

	it("take their file with them when nothing else plays it", () => {
		const document = withLayers();
		const withoutOutro = removeLayer(document, layerOf(document, "outro").id);
		expect(withoutOutro.assets.map((asset) => asset.id)).toEqual(["song", "intro"]);
		const twice = addLayers(document, [
			{ assetId: "song", kind: "music", label: "again", durationSec: 30 },
		]).document;
		const once = removeLayer(twice, layerOf(twice, "song").id);
		expect(once.assets.some((asset) => asset.id === "song")).toBe(true);
	});

	it("speak volume in percent: 0 dB is 100%", () => {
		expect([0, -6, 6, -60, 12].map(volumeFromGainDb)).toEqual([100, 50, 200, 0, 398]);
	});
});

describe("the programme's own tracks", () => {
	it("become layers once, and the applied mix never does", () => {
		const document = {
			...base(),
			audioTracks: [
				{
					...createAudioTrack({
						assetId: "song",
						durationSec: 30,
						timelineStartSec: 2,
						spanSec: 10,
					}),
					offsetMs: 5000,
					gainDb: -6,
					fadeOutMs: 1500,
				},
				createAudioTrack({ assetId: "intro", durationSec: 6, kind: "voiceover" }),
			],
		};
		const adopted = adoptProgrammeTracks(document);
		expect(
			audioBoardOf(adopted).layers.map((layer) => ({
				asset: layer.assetId,
				kind: layer.kind,
				start: layer.startSec,
				in: layer.inSec,
				out: layer.outSec,
				volume: layer.volume,
				fadeOut: layer.fadeOutSec,
			})),
		).toEqual([
			{ asset: "song", kind: "music", start: 2, in: 5, out: 15, volume: 50, fadeOut: 1.5 },
			{ asset: "intro", kind: "voiceover", start: 0, in: 0, out: 6, volume: 100, fadeOut: 0 },
		]);
		expect(adoptProgrammeTracks(adopted)).toBe(adopted);
	});
});

describe("the mix", () => {
	it("asks for every layer that makes a sound, by file, with fades that fit", () => {
		let document = withLayers();
		document = updateLayer(document, layerOf(document, "song").id, {
			volume: 40,
			fadeInSec: 2,
			fadeOutSec: 3,
			outSec: 12,
		});
		document = updateLayer(document, layerOf(document, "outro").id, { muted: true });
		expect(mixSpec(document)).toEqual({
			layers: [
				{
					path: "C:/audio/song.mp3",
					startSec: 0,
					inSec: 0,
					outSec: 12,
					gain: 0.4,
					fadeInSec: 2,
					fadeOutSec: 3,
				},
				{
					path: "C:/audio/intro.mp3",
					startSec: 0,
					inSec: 0,
					outSec: 6,
					gain: 1,
					fadeInSec: 0,
					fadeOutSec: 0,
				},
			],
			durationSec: 12,
		});
		expect(mixDurationSec(audioBoardOf(document).layers)).toBe(12);
	});

	it("shares fades that overrun a layer in proportion", () => {
		let document = withLayers();
		const id = layerOf(document, "outro").id;
		document = updateLayer(document, id, { fadeInSec: 3, fadeOutSec: 3 });
		const outro = mixSpec(document)?.layers.find((layer) => layer.path.endsWith("outro.mp3"));
		expect(outro).toMatchObject({ fadeInSec: 2, fadeOutSec: 2 });
	});

	it("is empty with nothing to hear", () => {
		let document = withLayers();
		for (const layer of audioBoardOf(document).layers)
			document = updateLayer(document, layer.id, { volume: 0 });
		expect(mixSpec(document)).toBeNull();
		expect(mixStatus(document)).toBe("empty");
		expect(mixStatus(base())).toBe("empty");
	});

	it("replaces the programme's audio with one locked track, in one edit", () => {
		const document = {
			...withLayers(),
			audioTracks: [createAudioTrack({ assetId: "song", durationSec: 30 })],
		};
		const adopted = adoptProgrammeTracks(document);
		expect(mixStatus(adopted)).toBe("unapplied");
		const signature = mixSignature(mixSpec(adopted));
		const mixAsset = audio("mix", 30);
		const applied = applyMix(
			{ ...adopted, assets: [...adopted.assets, mixAsset] },
			{ assetId: "mix", durationSec: 30, signature },
		);
		expect(applied.audioTracks).toHaveLength(1);
		expect(applied.audioTracks[0]).toMatchObject({
			assetId: "mix",
			kind: "voiceover",
			startMs: 0,
			endMs: 30000,
			timelineLocked: true,
			label: "오디오 믹스",
		});
		expect(playsBoardMix(applied)).toBe(true);
		expect(mixStatus(applied)).toBe("applied");
		// The layers keep their files; the mix is not taken back as a layer.
		expect(applied.assets.map((asset) => asset.id)).toEqual(["song", "intro", "outro", "mix"]);
		expect(adoptProgrammeTracks(applied)).toBe(applied);
		const louder = updateLayer(applied, layerOf(applied, "song").id, { volume: 120 });
		expect(mixStatus(louder)).toBe("changed");
	});

	it("drops the mix it replaces", () => {
		const document = withLayers();
		const first = applyMix(
			{ ...document, assets: [...document.assets, audio("mix1", 30)] },
			{ assetId: "mix1", durationSec: 30, signature: "a" },
		);
		const second = applyMix(
			{ ...first, assets: [...first.assets, audio("mix2", 30)] },
			{ assetId: "mix2", durationSec: 30, signature: "b" },
		);
		expect(second.assets.map((asset) => asset.id)).toEqual(["song", "intro", "outro", "mix2"]);
		expect(audioBoardOf(second).mix).toEqual({ assetId: "mix2", signature: "b" });
	});

	it("is music when no narration is heard in it", () => {
		let document = withLayers();
		for (const assetId of ["intro", "outro"])
			document = updateLayer(document, layerOf(document, assetId).id, { muted: true });
		const applied = applyMix(document, { assetId: "song", durationSec: 30, signature: "" });
		expect(applied.audioTracks[0].kind).toBe("music");
	});
});

describe("the mix's words", () => {
	const transcript = (
		assetId: string,
		words: Array<[string, number, number]>,
	): AxcutTranscript => ({
		assetId,
		language: "ko",
		segments: [
			{
				id: "s1",
				kind: "speech",
				startSec: words[0][1],
				endSec: words[words.length - 1][2],
				text: words.map(([text]) => text).join(" "),
				wordIds: words.map((_, index) => `w${index}`),
			},
		],
		words: words.map(([text, startSec, endSec], index) => ({
			id: `w${index}`,
			segmentId: "s1",
			startSec,
			endSec,
			text,
		})),
	});

	function narrated() {
		let document = withLayers();
		// The intro plays from 1 s of its file, 2 s into the mix; the outro follows at 8 s.
		document = updateLayer(document, layerOf(document, "intro").id, { startSec: 2, inSec: 1 });
		document = updateLayer(document, layerOf(document, "outro").id, { startSec: 8 });
		return {
			...document,
			transcripts: [
				transcript("intro", [
					["잘린", 0.2, 0.8],
					["안녕하세요", 1.2, 2],
					["여러분", 2.1, 2.8],
				]),
				transcript("outro", [["감사합니다", 0.5, 1.5]]),
			],
		};
	}

	it("are the narrations' words where the mix plays them", () => {
		const applied = applyMix(narrated(), { assetId: "mix", durationSec: 30, signature: "" });
		const words = applied.transcripts.find((entry) => entry.assetId === "mix")?.words ?? [];
		expect(words.map((word) => [word.text, word.startSec, word.endSec])).toEqual([
			["안녕하세요", 2.2, 3],
			["여러분", 3.1, 3.8],
			["감사합니다", 8.5, 9.5],
		]);
		const segments = applied.transcripts.find((entry) => entry.assetId === "mix")?.segments ?? [];
		expect(segments).toHaveLength(2);
		expect(segments[0].wordIds).toHaveLength(2);
	});

	it("wait for every narration's transcript, and keep a correction made on the last mix", () => {
		const untranscribed = { ...narrated(), transcripts: [] };
		const applied = applyMix(untranscribed, { assetId: "mix", durationSec: 30, signature: "" });
		expect(applied.transcripts).toEqual([]);

		const first = applyMix(narrated(), { assetId: "mix", durationSec: 30, signature: "" });
		const corrected = {
			...first,
			transcripts: first.transcripts.map((entry) =>
				entry.assetId === "mix"
					? {
							...entry,
							words: entry.words.map((word) =>
								word.text === "여러분"
									? { ...word, text: "모두", originalText: "여러분", source: "user" as const }
									: word,
							),
						}
					: entry,
			),
		};
		const moved = updateLayer(corrected, layerOf(corrected, "outro").id, { startSec: 10 });
		const second = applyMix(
			{ ...moved, assets: [...moved.assets, audio("mix2", 30)] },
			{ assetId: "mix2", durationSec: 30, signature: "" },
		);
		const words = second.transcripts.find((entry) => entry.assetId === "mix2")?.words ?? [];
		expect(words.map((word) => word.text)).toEqual(["안녕하세요", "모두", "감사합니다"]);
		expect(words[2].startSec).toBe(10.5);
	});
});

describe("preview", () => {
	it("plays a layer as a track: its span, its offset, its fades", () => {
		const layer = normalizedLayer(layerOf(withLayers(), "outro"), {
			startSec: 5,
			inSec: 1,
			outSec: 3,
			fadeInSec: 0.5,
		});
		expect(layerAsTrack(layer, 4)).toMatchObject({
			startMs: 5000,
			endMs: 7000,
			offsetMs: 1000,
			durationSec: 4,
			fadeInMs: 500,
			loop: false,
		});
	});
});
