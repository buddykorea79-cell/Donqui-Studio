// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AxcutDocument, createAudioTrack, createEmptyDocument } from "@/lib/ai-edition/schema";
import { enqueueDocumentWrite } from "@/lib/ai-edition/store/documentWriteQueue";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { supersedeInFlightWrites } from "@/lib/ai-edition/store/undoStack";
import { AudioStage } from "./AudioStage";

vi.mock("@/native/client", () => ({ nativeBridgeClient: { aiEdition: {} } }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const asset = {
	id: "song",
	kind: "audio" as const,
	originalPath: "C:/media/song.wav",
	label: "My song",
	durationSec: 12,
	cameraTrack: null,
};
const picker = vi.fn();
const addAudioAsset = vi.fn();
const save = vi.fn(async (document: AxcutDocument) => {
	useProjectStore.setState({ document });
	return true;
});
const originalStore = useProjectStore.getState();
const originalApi = window.electronAPI;
const pause = vi.fn();
const mutations = [
	{ action: "import", button: "음악 가져오기" },
	{ action: "settings", button: "설정 적용" },
	{ action: "remove", button: "삭제" },
] as const;

function holdDocumentWrite(commit: () => void = () => undefined) {
	let release: () => void = () => undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const pending = enqueueDocumentWrite(async () => {
		await gate;
		commit();
	});
	return { release, pending };
}

function withAudio() {
	const document = createEmptyDocument({ projectId: "p", title: "Music first" });
	document.assets = [asset];
	document.audioTracks = [
		{
			...createAudioTrack({ assetId: asset.id, durationSec: 12, label: asset.label }),
			timelineLocked: true,
		},
	];
	useProjectStore.setState({ projectId: "p", document });
	return document;
}

beforeEach(() => {
	vi.stubGlobal(
		"requestAnimationFrame",
		vi.fn(() => 1),
	);
	vi.stubGlobal("cancelAnimationFrame", vi.fn());
	vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(pause);
	vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
	useProjectStore.setState({
		...originalStore,
		projectId: null,
		document: null,
		currentTimeSec: 0,
		playing: false,
		selectedAudioTrackId: null,
		saveDocument: save,
		addAudioAsset,
	});
	Object.defineProperty(window, "electronAPI", {
		configurable: true,
		value: { openAudioFilePicker: picker },
	});
	picker.mockReset();
	addAudioAsset.mockReset();
	save.mockClear();
	pause.mockClear();
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	useProjectStore.setState(originalStore, true);
	Object.defineProperty(window, "electronAPI", { configurable: true, value: originalApi });
});

describe("AudioStage", () => {
	it("lets an empty project continue directly to V.Clip", () => {
		const onContinue = vi.fn();
		render(<AudioStage onContinue={onContinue} onNewProject={vi.fn()} />);
		expect(screen.getByRole("button", { name: "음악 가져오기" })).toBeDisabled();
		fireEvent.click(screen.getByRole("button", { name: /V\.Clip으로 이동/ }));
		expect(onContinue).toHaveBeenCalledOnce();
	});

	it("imports narration before visual clips and keeps its whole source duration", async () => {
		useProjectStore.setState({
			projectId: "p",
			document: createEmptyDocument({ projectId: "p", title: "Narration" }),
		});
		picker.mockResolvedValue({ success: true, path: asset.originalPath, name: asset.label });
		addAudioAsset.mockImplementation(() =>
			enqueueDocumentWrite(() => {
				const document = useProjectStore.getState().document;
				if (document) useProjectStore.setState({ document: { ...document, assets: [asset] } });
				return asset;
			}),
		);
		render(<AudioStage onContinue={vi.fn()} onNewProject={vi.fn()} />);
		fireEvent.click(screen.getByRole("button", { name: "나레이션 가져오기" }));
		await waitFor(() => expect(save).toHaveBeenCalledOnce());
		expect(useProjectStore.getState().document?.audioTracks[0]).toMatchObject({
			kind: "voiceover",
			startMs: 0,
			endMs: 12_000,
			durationSec: 12,
			timelineLocked: true,
		});
		expect(useProjectStore.getState().document?.timeline.clips).toEqual([]);
		expect(screen.getByLabelText("선택한 오디오 미리보기")).toHaveAttribute("controls");
	});

	it("does not change the project after a cancelled picker", async () => {
		withAudio();
		picker.mockResolvedValue({ success: false, canceled: true });
		render(<AudioStage onContinue={vi.fn()} onNewProject={vi.fn()} />);
		fireEvent.click(screen.getByRole("button", { name: "음악 가져오기" }));
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "음악 가져오기" })).toBeEnabled(),
		);
		expect(addAudioAsset).not.toHaveBeenCalled();
		expect(save).not.toHaveBeenCalled();
	});

	it("saves trim, placement and volume together", async () => {
		withAudio();
		render(<AudioStage onContinue={vi.fn()} onNewProject={vi.fn()} />);
		fireEvent.change(screen.getByLabelText("타임라인 시작 (초)"), { target: { value: "4" } });
		fireEvent.change(screen.getByLabelText("원본 시작 (초)"), { target: { value: "2" } });
		fireEvent.change(screen.getByLabelText("원본 종료 (초)"), { target: { value: "8" } });
		fireEvent.change(screen.getByLabelText("볼륨 (dB)"), { target: { value: "-12" } });
		fireEvent.click(screen.getByRole("button", { name: "설정 적용" }));
		await waitFor(() => expect(save).toHaveBeenCalledOnce());
		expect(useProjectStore.getState().document?.audioTracks[0]).toMatchObject({
			startMs: 4000,
			endMs: 10000,
			offsetMs: 2000,
			gainDb: -12,
		});
	});

	it.each(mutations)("keeps an earlier import when the queued $action commits", async ({
		action,
		button,
	}) => {
		const document = withAudio();
		const importedAsset = { ...asset, id: "another-import", label: "Another source" };
		picker.mockResolvedValue({ success: true, path: asset.originalPath, name: asset.label });
		addAudioAsset.mockResolvedValue(asset);
		render(<AudioStage onContinue={vi.fn()} onNewProject={vi.fn()} />);
		fireEvent.change(screen.getByLabelText("볼륨 (dB)"), { target: { value: "-12" } });
		const held = holdDocumentWrite(() => {
			useProjectStore.setState({
				document: { ...document, assets: [...document.assets, importedAsset] },
			});
		});
		try {
			fireEvent.click(screen.getByRole("button", { name: button }));
			await act(async () => undefined);
			expect(save).not.toHaveBeenCalled();
		} finally {
			await act(async () => {
				held.release();
				await held.pending;
				await enqueueDocumentWrite(() => undefined);
			});
		}
		await waitFor(() => expect(save).toHaveBeenCalledOnce());
		const result = useProjectStore.getState().document;
		expect(result?.assets).toContainEqual(importedAsset);
		if (action === "import") expect(result?.audioTracks).toHaveLength(2);
		else if (action === "remove") expect(result?.audioTracks).toHaveLength(0);
		else expect(result?.audioTracks[0].gainDb).toBe(-12);
	});

	it.each(
		mutations.flatMap((mutation) =>
			(["project switch", "undo"] as const).map((change) => ({ ...mutation, change })),
		),
	)("discards queued $action after a $change", async ({ button, change }) => {
		const document = withAudio();
		picker.mockResolvedValue({ success: true, path: asset.originalPath, name: asset.label });
		addAudioAsset.mockResolvedValue(asset);
		render(<AudioStage onContinue={vi.fn()} onNewProject={vi.fn()} />);
		const held = holdDocumentWrite();
		try {
			fireEvent.click(screen.getByRole("button", { name: button }));
			await act(async () => undefined);
			act(() => {
				if (change === "undo") supersedeInFlightWrites();
				else
					useProjectStore.setState({
						projectId: "other",
						document: { ...document, project: { ...document.project, id: "other" } },
					});
			});
		} finally {
			await act(async () => {
				held.release();
				await held.pending;
				await enqueueDocumentWrite(() => undefined);
			});
		}
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "음악 가져오기" })).toBeEnabled(),
		);
		expect(save).not.toHaveBeenCalled();
		expect(useProjectStore.getState().document?.audioTracks).toEqual(document.audioTracks);
	});

	it("pauses source audition when the full audio timeline starts, preventing doubled audio", () => {
		withAudio();
		render(<AudioStage onContinue={vi.fn()} onNewProject={vi.fn()} />);
		const source = screen.getByLabelText("선택한 오디오 미리보기");
		Object.defineProperty(source, "paused", { configurable: true, value: false });
		fireEvent.click(screen.getByRole("button", { name: "오디오 전체 미리보기" }));
		expect(pause).toHaveBeenCalledOnce();
		expect(useProjectStore.getState().playing).toBe(true);
		fireEvent.play(source);
		expect(useProjectStore.getState().playing).toBe(false);
	});

	it("advances and stops the audio clock without a visual clip", () => {
		withAudio();
		render(<AudioStage onContinue={vi.fn()} onNewProject={vi.fn()} />);
		const callback = vi.mocked(requestAnimationFrame).mock.calls[0][0];
		act(() => {
			useProjectStore.setState({ currentTimeSec: 11.95, playing: true });
			callback(performance.now() + 100);
		});
		expect(useProjectStore.getState().currentTimeSec).toBe(12);
		expect(useProjectStore.getState().playing).toBe(false);
	});
});
