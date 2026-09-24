// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AxcutAsset,
	type AxcutDocument,
	createAudioTrack,
	createEmptyDocument,
} from "@/lib/ai-edition/schema";
import { enqueueDocumentWrite } from "@/lib/ai-edition/store/documentWriteQueue";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { supersedeInFlightWrites } from "@/lib/ai-edition/store/undoStack";
import { addLayers, audioBoardOf, mixSignature, mixSpec } from "@/lib/audio-board/board";
import { useAudioMixStore } from "@/lib/audio-board/store";
import { draggedLayer } from "./AudioLayerTimeline";
import { AudioStage } from "./AudioStage";

const mocks = vi.hoisted(() => ({
	toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock("@/native/client", () => ({ nativeBridgeClient: { aiEdition: {} } }));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/hooks/useAudioPeaks", () => ({ useAudioPeaks: () => null }));

const audio = (id: string, durationSec: number): AxcutAsset => ({
	id,
	kind: "audio",
	label: `${id}.mp3`,
	originalPath: `C:/media/${id}.mp3`,
	durationSec,
	cameraTrack: null,
});
const song = audio("song", 12);
const intro = audio("intro", 4);
const outro = audio("outro", 3);

const api = { openAudioFilesPicker: vi.fn(), createAudioMix: vi.fn() };
const addAudioAsset = vi.fn();
const save = vi.fn(async (document: AxcutDocument, _options: { history: boolean }) => {
	useProjectStore.setState({ document });
	return true;
});
const originalStore = useProjectStore.getState();
const originalApi = window.electronAPI;

/** Adds the picked file's asset the way the store does: through the document queue. */
function importsAs(...assets: AxcutAsset[]) {
	addAudioAsset.mockImplementation((path: string) =>
		enqueueDocumentWrite(() => {
			const asset = assets.find((entry) => entry.originalPath === path) ?? null;
			const document = useProjectStore.getState().document;
			if (asset && document)
				useProjectStore.setState({
					document: { ...document, assets: [...document.assets, asset] },
				});
			return asset;
		}),
	);
}

function project(document = createEmptyDocument({ projectId: "p", title: "Audio" })) {
	useProjectStore.setState({ projectId: "p", document });
	return document;
}

/** A song under two narrations, already on the board. */
function withLayers() {
	const base = {
		...createEmptyDocument({ projectId: "p", title: "Audio" }),
		assets: [song, intro, outro],
	};
	const music = addLayers(base, [{ assetId: "song", kind: "music", label: "", durationSec: 12 }]);
	return project(
		addLayers(music.document, [
			{ assetId: "intro", kind: "voiceover", label: "", durationSec: 4 },
			{ assetId: "outro", kind: "voiceover", label: "", durationSec: 3 },
		]).document,
	);
}

const layer = (assetId: string) => {
	const found = audioBoardOf(useProjectStore.getState().document).layers.find(
		(entry) => entry.assetId === assetId,
	);
	if (!found) throw new Error(`no layer for ${assetId}`);
	return found;
};

const renderAudio = () => render(<AudioStage onContinue={vi.fn()} onNewProject={vi.fn()} />);

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubGlobal(
		"requestAnimationFrame",
		vi.fn(() => 1),
	);
	vi.stubGlobal("cancelAnimationFrame", vi.fn());
	vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
	vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
	useProjectStore.setState({
		...originalStore,
		projectId: null,
		document: null,
		currentTimeSec: 0,
		playing: false,
		saveDocument: save,
		addAudioAsset,
	});
	useAudioMixStore.setState({ applying: false });
	Object.defineProperty(window, "electronAPI", { configurable: true, value: api });
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	useProjectStore.setState(originalStore, true);
	Object.defineProperty(window, "electronAPI", { configurable: true, value: originalApi });
});

describe("Audio's layers", () => {
	it("lets an empty project continue straight to V.Clip", () => {
		const onContinue = vi.fn();
		render(<AudioStage onContinue={onContinue} onNewProject={vi.fn()} />);
		expect(screen.getByRole("button", { name: "음악 가져오기" })).toBeDisabled();
		fireEvent.click(screen.getByRole("button", { name: /V\.Clip으로 이동/ }));
		expect(onContinue).toHaveBeenCalledOnce();
	});

	it("imports several narrations at once, one after another on rows of their own", async () => {
		project();
		importsAs(intro, outro);
		api.openAudioFilesPicker.mockResolvedValue({
			success: true,
			files: [
				{ path: intro.originalPath, name: "intro.mp3" },
				{ path: outro.originalPath, name: "outro.mp3" },
			],
			rejected: [],
		});
		renderAudio();
		fireEvent.click(screen.getByRole("button", { name: "나레이션 가져오기" }));
		await waitFor(() =>
			expect(mocks.toast.success).toHaveBeenCalledWith(
				"나레이션 2개를 레이어로 넣었습니다.",
				undefined,
			),
		);
		expect(layer("intro")).toMatchObject({ kind: "voiceover", startSec: 0, outSec: 4 });
		expect(layer("outro")).toMatchObject({ startSec: 4, outSec: 3 });
		// Nothing plays yet: the board is applied to Media only on request.
		expect(useProjectStore.getState().document?.audioTracks).toEqual([]);
		expect(screen.getByRole("button", { name: "intro.mp3 레이어" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		expect(screen.getByRole("region", { name: "레이어 설정" })).toBeInTheDocument();
		expect(screen.getByText("아직 Media에 반영하지 않았습니다")).toBeInTheDocument();
	});

	it("changes nothing when the picker is cancelled", async () => {
		project();
		api.openAudioFilesPicker.mockResolvedValue({
			success: false,
			canceled: true,
			files: [],
			rejected: [],
		});
		renderAudio();
		fireEvent.click(screen.getByRole("button", { name: "음악 가져오기" }));
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "음악 가져오기" })).toBeEnabled(),
		);
		expect(addAudioAsset).not.toHaveBeenCalled();
		expect(save).not.toHaveBeenCalled();
	});

	it("takes the programme's own tracks as layers, without an undo step", async () => {
		const document = project({
			...createEmptyDocument({ projectId: "p", title: "Audio" }),
			assets: [song],
			audioTracks: [
				{
					...createAudioTrack({ assetId: "song", durationSec: 12 }),
					gainDb: -6,
					timelineLocked: true,
				},
			],
		});
		renderAudio();
		await waitFor(() => expect(save).toHaveBeenCalledOnce());
		expect(save.mock.calls[0][1]).toEqual({ history: false });
		expect(layer("song")).toMatchObject({ volume: 50, trackId: document.audioTracks[0].id });
		expect(await screen.findByRole("button", { name: "song.mp3 레이어" })).toBeInTheDocument();
	});
});

describe("a layer's settings", () => {
	it("set its volume in percent — typed, preset or dragged — and write it once", async () => {
		withLayers();
		renderAudio();
		fireEvent.click(screen.getByRole("button", { name: "song.mp3 레이어" }));
		const settings = screen.getByRole("region", { name: "레이어 설정" });
		fireEvent.change(within(settings).getByLabelText("볼륨 (%)"), { target: { value: "35" } });
		fireEvent.blur(within(settings).getByLabelText("볼륨 (%)"));
		await waitFor(() => expect(layer("song").volume).toBe(35));

		fireEvent.click(within(settings).getByRole("button", { name: "150%" }));
		await waitFor(() => expect(layer("song").volume).toBe(150));

		save.mockClear();
		const slider = within(settings).getByLabelText("볼륨");
		fireEvent.change(slider, { target: { value: "80" } });
		fireEvent.change(slider, { target: { value: "70" } });
		expect(save).not.toHaveBeenCalled();
		expect(screen.getByText("70%")).toBeInTheDocument();
		fireEvent.pointerUp(slider);
		await waitFor(() => expect(layer("song").volume).toBe(70));
		expect(save).toHaveBeenCalledOnce();
		expect(save.mock.calls[0][1]).toEqual({ history: true });
	});

	it("trim, place, fade, mute, change kind and delete", async () => {
		withLayers();
		renderAudio();
		fireEvent.click(screen.getByRole("button", { name: "intro.mp3 레이어" }));
		const settings = screen.getByRole("region", { name: "레이어 설정" });
		const set = async (label: string, value: string) => {
			fireEvent.change(within(settings).getByLabelText(label), { target: { value } });
			fireEvent.keyDown(within(settings).getByLabelText(label), { key: "Enter" });
			await waitFor(() =>
				expect(within(settings).getByLabelText(label)).toHaveValue(Number(value)),
			);
		};
		await set("타임라인 시작 (초)", "1.5");
		await set("원본 시작 (초)", "0.5");
		await set("원본 끝 (초)", "3.5");
		await set("페이드 인 (초)", "0.4");
		await waitFor(() =>
			expect(layer("intro")).toMatchObject({
				startSec: 1.5,
				inSec: 0.5,
				outSec: 3.5,
				fadeInSec: 0.4,
			}),
		);
		fireEvent.click(within(settings).getByRole("checkbox"));
		await waitFor(() => expect(layer("intro").muted).toBe(true));
		fireEvent.click(within(settings).getByRole("button", { name: "음악" }));
		await waitFor(() => expect(layer("intro").kind).toBe("music"));
		fireEvent.click(within(settings).getByRole("button", { name: /레이어 삭제/ }));
		await waitFor(() =>
			expect(
				audioBoardOf(useProjectStore.getState().document).layers.map((entry) => entry.assetId),
			).toEqual(["song", "outro"]),
		);
		expect(useProjectStore.getState().document?.assets.map((asset) => asset.id)).toEqual([
			"song",
			"outro",
		]);
	});
});

describe("the layer timeline", () => {
	beforeEach(() => {
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
			left: 0,
			top: 0,
			right: 1000,
			bottom: 40,
			width: 1000,
			height: 40,
			x: 0,
			y: 0,
			toJSON: () => ({}),
		});
	});

	it("moves a layer by dragging it and writes it once, on release", async () => {
		withLayers();
		renderAudio();
		// 12 s of layers in a 15 s view, 1000 px wide: 100 px is 1.5 s.
		const pill = screen.getByRole("button", { name: "outro.mp3 레이어" });
		save.mockClear();
		fireEvent.pointerDown(pill, { clientX: 300 });
		fireEvent.pointerMove(pill, { clientX: 350 });
		fireEvent.pointerMove(pill, { clientX: 400 });
		expect(save).not.toHaveBeenCalled();
		fireEvent.pointerUp(pill, { clientX: 400 });
		await waitFor(() => expect(layer("outro").startSec).toBe(5.5));
		expect(save).toHaveBeenCalledOnce();
	});

	it("trims a layer at either edge, the in-point carrying its start along", async () => {
		withLayers();
		renderAudio();
		const pill = screen.getByRole("button", { name: "intro.mp3 레이어" });
		const [head, tail] = within(pill).getAllByLabelText(/자르기$/);
		fireEvent.pointerDown(head, { clientX: 0 });
		fireEvent.pointerMove(pill, { clientX: 20 });
		fireEvent.pointerUp(pill, { clientX: 20 });
		await waitFor(() => expect(layer("intro")).toMatchObject({ startSec: 0.3, inSec: 0.3 }));
		fireEvent.pointerDown(tail, { clientX: 260 });
		fireEvent.pointerMove(pill, { clientX: 220 });
		fireEvent.pointerUp(pill, { clientX: 220 });
		await waitFor(() => expect(layer("intro").outSec).toBe(3.4));
	});

	it("nudges the selected layer with the arrow keys and mutes from its row", async () => {
		withLayers();
		renderAudio();
		const pill = screen.getByRole("button", { name: "outro.mp3 레이어" });
		fireEvent.keyDown(pill, { key: "ArrowRight" });
		await waitFor(() => expect(layer("outro").startSec).toBe(4.1));
		fireEvent.keyDown(pill, { key: "ArrowLeft", shiftKey: true });
		await waitFor(() => expect(layer("outro").startSec).toBe(3.1));
		fireEvent.click(screen.getByRole("button", { name: "outro.mp3 음소거" }));
		await waitFor(() => expect(layer("outro").muted).toBe(true));
	});

	it("drags onto the edges of other layers and the start", () => {
		const base = {
			id: "a",
			assetId: "a",
			kind: "voiceover" as const,
			label: "",
			startSec: 5,
			inSec: 1,
			outSec: 4,
			volume: 100,
			fadeInSec: 0,
			fadeOutSec: 0,
			muted: false,
		};
		// Moved 1.9 s left, its head lands 0.1 s from another layer's end at 3 s: it snaps there.
		expect(draggedLayer(base, "move", -1.9, 10, [0, 3], 0.2)).toEqual({ startSec: 3 });
		// Its tail snaps too: moved right, it ends on the 11 s mark.
		expect(draggedLayer(base, "move", 2.9, 10, [11], 0.2)).toEqual({ startSec: 8 });
		expect(draggedLayer(base, "move", -9, 10)).toEqual({ startSec: 0 });
		// The in-point cannot go before the file's start, nor the layer before 0.
		expect(draggedLayer(base, "in", -3, 10)).toEqual({ startSec: 4, inSec: 0 });
		expect(draggedLayer(base, "in", 5, 10)).toEqual({ startSec: 7.9, inSec: 3.9 });
		// The out-point stops at the file's end.
		expect(draggedLayer(base, "out", 20, 6)).toEqual({ outSec: 6 });
	});
});

describe("preview", () => {
	it("plays the layers on the page's clock and stops at the mix's end", () => {
		withLayers();
		renderAudio();
		fireEvent.click(screen.getByRole("button", { name: "미리듣기" }));
		expect(useProjectStore.getState().playing).toBe(true);
		expect(screen.getByRole("button", { name: "일시 정지" })).toBeInTheDocument();
		const tick = vi.mocked(requestAnimationFrame).mock.calls[0][0];
		// At 1 s the song and the first narration sound; the second has not started.
		act(() => {
			useProjectStore.setState({ currentTimeSec: 1 });
			tick(performance.now() + 16);
		});
		expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
		act(() => {
			useProjectStore.setState({ currentTimeSec: 11.95 });
			tick(performance.now() + 100);
		});
		expect(useProjectStore.getState().currentTimeSec).toBe(12);
		expect(useProjectStore.getState().playing).toBe(false);
	});
});

describe("applying to Media", () => {
	const mix = { ...audio("mix", 12), label: "오디오 믹스", originalPath: "C:/userdata/mix.wav" };

	it("mixes the layers into one track the programme plays alone", async () => {
		const document = withLayers();
		importsAs(mix);
		api.createAudioMix.mockResolvedValue({
			success: true,
			filePath: mix.originalPath,
			durationSec: 12,
			peakDb: -2,
		});
		renderAudio();
		fireEvent.click(screen.getByRole("button", { name: "Media에 반영" }));
		await waitFor(() => expect(screen.getByText(/Media에 반영됨/)).toBeInTheDocument());
		expect(api.createAudioMix).toHaveBeenCalledWith(mixSpec(document));
		const result = useProjectStore.getState().document;
		expect(result?.audioTracks).toHaveLength(1);
		expect(result?.audioTracks[0]).toMatchObject({
			assetId: "mix",
			kind: "voiceover",
			endMs: 12000,
			timelineLocked: true,
		});
		expect(audioBoardOf(result).mix).toEqual({
			assetId: "mix",
			signature: mixSignature(mixSpec(document)),
		});
		expect(screen.getByRole("button", { name: "Media에 반영" })).toBeDisabled();
		expect(mocks.toast.success).toHaveBeenCalledWith(
			"오디오 믹스(0:12.0)를 Media에 반영했습니다.",
			{ description: "레이어 3개를 한 오디오로 섞었습니다." },
		);
		expect(mocks.toast.warning).not.toHaveBeenCalled();
	});

	it("says how much quieter a clipping mix has to be", async () => {
		withLayers();
		importsAs(mix);
		api.createAudioMix.mockResolvedValue({
			success: true,
			filePath: mix.originalPath,
			durationSec: 12,
			peakDb: 2,
		});
		renderAudio();
		fireEvent.click(screen.getByRole("button", { name: "Media에 반영" }));
		await waitFor(() =>
			expect(mocks.toast.warning).toHaveBeenCalledWith(
				"믹스가 너무 커서 가장 큰 소리가 잘립니다.",
				{
					description: "레이어 볼륨을 약 21% 낮춰 다시 반영하세요.",
				},
			),
		);
	});

	it("reports a mix that failed and changes nothing", async () => {
		const document = withLayers();
		api.createAudioMix.mockResolvedValue({ success: false, error: "No audio in intro.mp3" });
		renderAudio();
		fireEvent.click(screen.getByRole("button", { name: "Media에 반영" }));
		await waitFor(() =>
			expect(mocks.toast.error).toHaveBeenCalledWith("오디오를 반영하지 못했습니다.", {
				description: "No audio in intro.mp3",
			}),
		);
		expect(useProjectStore.getState().document).toBe(document);
		expect(screen.getByRole("button", { name: "Media에 반영" })).toBeEnabled();
	});

	it("drops a mix that an undo overtook", async () => {
		const document = withLayers();
		let finish: (value: unknown) => void = () => undefined;
		api.createAudioMix.mockReturnValue(
			new Promise((resolve) => {
				finish = resolve;
			}),
		);
		renderAudio();
		fireEvent.click(screen.getByRole("button", { name: "Media에 반영" }));
		expect(await screen.findByText("오디오를 하나로 섞는 중…")).toBeInTheDocument();
		act(() => supersedeInFlightWrites());
		await act(async () => {
			finish({ success: true, filePath: mix.originalPath, durationSec: 12, peakDb: -3 });
		});
		await waitFor(() => expect(screen.getByRole("button", { name: "Media에 반영" })).toBeEnabled());
		expect(addAudioAsset).not.toHaveBeenCalled();
		expect(useProjectStore.getState().document).toBe(document);
	});

	it("shows what changed since the mix was applied", async () => {
		withLayers();
		importsAs(mix);
		api.createAudioMix.mockResolvedValue({
			success: true,
			filePath: mix.originalPath,
			durationSec: 12,
			peakDb: -3,
		});
		renderAudio();
		fireEvent.click(screen.getByRole("button", { name: "Media에 반영" }));
		await screen.findByText(/Media에 반영됨/);
		fireEvent.click(screen.getByRole("button", { name: "song.mp3 음소거" }));
		expect(await screen.findByText("바뀐 내용이 있습니다 · 다시 반영하세요")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Media에 반영" })).toBeEnabled();
	});
});
