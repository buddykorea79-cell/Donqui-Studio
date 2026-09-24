// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AxcutDocument, createAudioTrack, createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import type { VClipWindowAnalysis, VClipWindowRequest } from "@/lib/vclip/contract";
import { useVClipStore } from "@/lib/vclip/store";
import { VClipStage } from "./VClipStage";

const mocks = vi.hoisted(() => ({ addEffectClip: vi.fn(), probeDuration: vi.fn() }));
vi.mock("@/lib/clip-effects/addEffectClip", () => ({ addEffectClip: mocks.addEffectClip }));
vi.mock("@/lib/ai-edition/timeline/duration", () => ({
	probeVideoDuration: mocks.probeDuration,
	probeVideoDimensions: mocks.probeDuration,
}));
vi.mock("./ClipPreview", () => ({
	ClipPreview: (props: { effect: string; startMs: number; endMs: number }) => (
		<div data-testid="clip-preview">
			{props.effect}:{props.startMs}:{props.endMs}
		</div>
	),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const drone = {
	id: "drone",
	kind: "video" as const,
	label: "DJI_0017.MP4",
	originalPath: "C:/footage/DJI_0017.MP4",
	cameraTrack: null,
};
const api = {
	vclipListModels: vi.fn(),
	vclipProbe: vi.fn(),
	vclipAnalyzeWindow: vi.fn(),
	vclipCancel: vi.fn(),
	openVideoFilePicker: vi.fn(),
};
const onAdd = vi.fn(async () => undefined);
const initialVClip = useVClipStore.getState();
const initialProject = useProjectStore.getState();

function judged(request: VClipWindowRequest): VClipWindowAnalysis {
	return {
		startSec: request.startSec,
		endSec: request.endSec,
		score: 90 - request.startSec,
		qualityScore: 77,
		reason: `바다 위 구간 ${request.startSec}`,
		quality: { brightness: 0.8, motion: 0.6, sharpness: 0.7, stability: 0.9 },
		ai: {
			score: 90 - request.startSec,
			category: "orbit",
			description: `바다 위 구간 ${request.startSec}`,
			caption: "절벽을 돌아",
			tags: ["sea"],
		},
		aiError: null,
		thumbnail: null,
	};
}

function documentWith(audioSec: number): AxcutDocument {
	const document = createEmptyDocument({ projectId: "p", title: "V.Clip" });
	document.assets = [drone];
	if (audioSec > 0)
		document.audioTracks = [
			createAudioTrack({ assetId: "music", durationSec: audioSec, kind: "music", label: "BGM" }),
		];
	return document;
}

beforeEach(() => {
	vi.clearAllMocks();
	useVClipStore.setState(initialVClip, true);
	useProjectStore.setState({ projectId: "p", document: documentWith(12) });
	Object.defineProperty(window, "electronAPI", { configurable: true, value: api });
	api.vclipListModels.mockResolvedValue({
		available: true,
		baseUrl: "http://127.0.0.1:11434",
		error: null,
		models: [{ name: "qwen3-vl:4b", size: 3, parameterSize: "4.4B" }],
	});
	api.vclipProbe.mockResolvedValue({
		success: true,
		durationSec: 20,
		width: 3840,
		height: 2160,
		fps: 29.97,
		hasAudio: false,
	});
	api.vclipAnalyzeWindow.mockImplementation(async (request: VClipWindowRequest) => ({
		success: true,
		result: judged(request),
	}));
	mocks.addEffectClip.mockImplementation(
		async (request: { startMs: number }) => `clip-${request.startMs}`,
	);
});
afterEach(() => {
	cleanup();
	useProjectStore.setState(initialProject);
});

async function startAnalysis() {
	const button = await screen.findByRole("button", { name: /구간 찾기/ });
	// Held until Ollama's model list is in.
	await waitFor(() => expect(button).toBeEnabled());
	fireEvent.click(button);
}

async function findSegments() {
	await startAnalysis();
	await screen.findByText("바다 위 구간 15");
	return screen.getAllByRole("article");
}

describe("VClipStage", () => {
	it("opens on the first source and shows what FFmpeg read from it", async () => {
		render(<VClipStage onAddToTimeline={onAdd} onContinue={vi.fn()} />);
		expect(screen.getByRole("button", { name: /DJI_0017\.MP4/ })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		expect(
			await screen.findByText("0:20.0 · 3840×2160 · 29.97 fps · 소리 없음"),
		).toBeInTheDocument();
		expect(await screen.findByText(/Ollama 연결됨 · 비전 모델 1개/)).toBeInTheDocument();
		expect(screen.getByLabelText("분석 모델")).toHaveValue("qwen3-vl:4b");
		expect(screen.getByText(/남은 0:12\.0/)).toBeInTheDocument();
	});

	it("finds segments with the model, preselects the best three and makes them into clips", async () => {
		render(<VClipStage onAddToTimeline={onAdd} onContinue={vi.fn()} />);
		const cards = await findSegments();
		expect(cards).toHaveLength(4);
		expect(api.vclipAnalyzeWindow.mock.calls[0][0]).toMatchObject({ model: "qwen3-vl:4b" });
		expect(within(cards[0]).getByText("선회")).toBeInTheDocument();
		expect(within(cards[0]).getByText("화질 77")).toBeInTheDocument();
		expect(within(cards[0]).getByText("“절벽을 돌아”")).toBeInTheDocument();
		expect(screen.getByText(/선택 3개/)).toBeInTheDocument();

		fireEvent.click(
			screen.getByRole("button", { name: "선택한 구간 3개를 클립으로 만들고 타임라인에 추가" }),
		);
		await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(3));
		expect(mocks.addEffectClip.mock.calls.map((call) => call[0].startMs)).toEqual([0, 5000, 10000]);
		expect(await screen.findAllByText("클립 완성")).toHaveLength(3);
		expect(
			screen.getByRole("button", { name: "선택한 구간은 모두 클립으로 만들었습니다" }),
		).toBeDisabled();
	});

	it("lists footage, not the clips it has already rendered", () => {
		const document = documentWith(0);
		document.assets = [
			drone,
			{
				...drone,
				id: "rendered",
				label: "DJI_0017.MP4 · 0.0–5.0초 · 줌 인",
				originalPath: "C:/Users/me/AppData/Roaming/MangopangStudio/media/clip-effects/ab12.mp4",
			},
		];
		useProjectStore.setState({ document });
		const { unmount } = render(<VClipStage onAddToTimeline={onAdd} onContinue={vi.fn()} />);
		expect(
			within(screen.getByRole("complementary", { name: "소스 영상" })).getAllByRole("button"),
		).toHaveLength(2);
		expect(screen.queryByRole("button", { name: /0\.0–5\.0초/ })).not.toBeInTheDocument();
		unmount();
		// Unless Media handed that very clip over.
		useVClipStore.getState().selectSource("rendered");
		render(<VClipStage onAddToTimeline={onAdd} onContinue={vi.fn()} />);
		expect(screen.getByRole("button", { name: /0\.0–5\.0초/ })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
	});

	it("selects just enough segments to cover the audio still without picture", async () => {
		render(<VClipStage onAddToTimeline={onAdd} onContinue={vi.fn()} />);
		await findSegments();
		fireEvent.click(screen.getByRole("button", { name: "선택 해제" }));
		expect(screen.getByText(/선택 0개/)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "남은 Audio만큼 선택" }));
		// 12 s of audio: the three best 5 s segments.
		expect(screen.getByText(/선택 3개 · 0:15\.0/)).toBeInTheDocument();
	});

	it("locks the selection until the analysis has ranked every window", async () => {
		let release!: () => void;
		api.vclipAnalyzeWindow.mockImplementation(async (request: VClipWindowRequest) => {
			if (request.startSec === 15)
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			return { success: true, result: judged(request) };
		});
		render(<VClipStage onAddToTimeline={onAdd} onContinue={vi.fn()} />);
		await startAnalysis();
		const provisional = await screen.findAllByRole("article");
		expect(within(provisional[0]).getByRole("button", { name: "넣기" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "모두 선택" })).toBeDisabled();
		expect(screen.getByRole("progressbar", { name: "구간 분석" })).toBeInTheDocument();
		release();
		await screen.findByRole("button", { name: "구간 다시 찾기" });
		expect(
			within(screen.getAllByRole("article")[0]).getByRole("button", { name: "빼기" }),
		).toBeEnabled();
	});

	it("scores from frame quality when told not to use a model", async () => {
		render(<VClipStage onAddToTimeline={onAdd} onContinue={vi.fn()} />);
		await screen.findByText(/Ollama 연결됨/);
		fireEvent.change(screen.getByLabelText("분석 모델"), { target: { value: "" } });
		await findSegments();
		expect(api.vclipAnalyzeWindow.mock.calls[0][0].model).toBeNull();
	});

	it("says so when Ollama is not running, and still offers the analysis", async () => {
		api.vclipListModels.mockResolvedValue({
			available: false,
			baseUrl: "http://127.0.0.1:11434",
			error: "fetch failed: connect ECONNREFUSED 127.0.0.1:11434",
			models: [],
		});
		render(<VClipStage onAddToTimeline={onAdd} onContinue={vi.fn()} />);
		expect(
			await screen.findByText(/Ollama에 연결할 수 없어 화질 점수만으로 고릅니다/),
		).toBeInTheDocument();
		expect(screen.getByLabelText("분석 모델")).toHaveValue("");
		expect(screen.getByRole("button", { name: /구간 찾기/ })).toBeEnabled();
	});

	it("previews a segment with the effect its clip will get", async () => {
		render(<VClipStage onAddToTimeline={onAdd} onContinue={vi.fn()} />);
		const cards = await findSegments();
		fireEvent.change(screen.getByLabelText("Remotion 효과"), { target: { value: "zoom-out" } });
		fireEvent.change(within(cards[1]).getByLabelText("0:05.0–0:10.0 구간 효과"), {
			target: { value: "fade" },
		});
		fireEvent.click(within(cards[1]).getByRole("button", { name: "미리보기" }));
		expect(screen.getByTestId("clip-preview")).toHaveTextContent("fade:5000:10000");
		fireEvent.click(within(cards[0]).getByRole("button", { name: "미리보기" }));
		expect(screen.getByTestId("clip-preview")).toHaveTextContent("zoom-out:0:5000");
	});

	it("hands a segment to the manual cutter, starting from its range", async () => {
		render(<VClipStage onAddToTimeline={onAdd} onContinue={vi.fn()} />);
		const cards = await findSegments();
		fireEvent.click(within(cards[2]).getByRole("button", { name: "구간 다듬기" }));
		expect(screen.getByRole("tab", { name: /직접 자르기/ })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		expect(await screen.findByLabelText("클립 시작 (초)")).toHaveValue(10);
		expect(screen.getByLabelText("클립 끝 (초)")).toHaveValue(15);
		// FFmpeg already measured the source; the browser probe is not asked.
		expect(mocks.probeDuration).not.toHaveBeenCalled();
	});

	it("asks for a project before anything else", () => {
		useProjectStore.setState({ projectId: null, document: null });
		render(<VClipStage onAddToTimeline={onAdd} onContinue={vi.fn()} />);
		expect(screen.getByText("프로젝트를 먼저 만들거나 열어 주세요.")).toBeInTheDocument();
	});

	it("continues to Media", () => {
		const onContinue = vi.fn();
		render(<VClipStage onAddToTimeline={onAdd} onContinue={onContinue} />);
		fireEvent.click(screen.getByRole("button", { name: /Media로 이동/ }));
		expect(onContinue).toHaveBeenCalledOnce();
	});
});
