// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import type { VClipWindowAnalysis, VClipWindowRequest, VClipWindowResult } from "./contract";
import { effectiveModel, segmentEffect, useVClipStore, vclipKey } from "./store";

const mocks = vi.hoisted(() => ({
	addEffectClip: vi.fn(),
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
}));
vi.mock("@/lib/clip-effects/addEffectClip", () => ({ addEffectClip: mocks.addEffectClip }));
vi.mock("sonner", () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));

const source = { id: "drone", label: "DJI_0017.MP4", originalPath: "C:/footage/DJI_0017.MP4" };
const key = vclipKey("p", source.id);
const scores: Record<number, number> = { 0: 60, 5: 90, 10: 75, 15: 80 };

function analysis(request: VClipWindowRequest): VClipWindowAnalysis {
	return {
		startSec: request.startSec,
		endSec: request.endSec,
		score: scores[request.startSec] ?? 50,
		qualityScore: 70,
		reason: `window ${request.startSec}`,
		quality: { brightness: 0.8, motion: 0.6, sharpness: 0.7, stability: 0.9 },
		ai: null,
		aiError: null,
		thumbnail: null,
	};
}

const api = {
	vclipProbe: vi.fn(),
	vclipAnalyzeWindow: vi.fn(),
	vclipCancel: vi.fn(),
	vclipListModels: vi.fn(),
};
const initialVClip = useVClipStore.getState();
const initialProject = useProjectStore.getState();

beforeEach(() => {
	vi.clearAllMocks();
	useVClipStore.setState(initialVClip, true);
	useProjectStore.setState({ projectId: "p" });
	Object.defineProperty(window, "electronAPI", { configurable: true, value: api });
	api.vclipProbe.mockResolvedValue({
		success: true,
		durationSec: 20,
		width: 3840,
		height: 2160,
		fps: 29.97,
		hasAudio: false,
	});
	api.vclipAnalyzeWindow.mockImplementation(
		async (request: VClipWindowRequest): Promise<VClipWindowResult> => ({
			success: true,
			result: analysis(request),
		}),
	);
	api.vclipCancel.mockResolvedValue(undefined);
});
afterEach(() => {
	useProjectStore.setState(initialProject);
});

describe("analysis", () => {
	it("walks every window, then ranks and preselects the best three", async () => {
		useVClipStore.setState({ segmentSec: 5, model: null });
		await useVClipStore.getState().analyze(source);
		const run = useVClipStore.getState().runs[key];
		expect(run.status).toBe("done");
		expect(run.total).toBe(4);
		expect(run.completed).toBe(4);
		expect(run.model).toBeNull();
		expect(run.segments.map((segment) => [segment.startSec, segment.selected])).toEqual([
			[0, false],
			[5, true],
			[10, true],
			[15, true],
		]);
		const requests = api.vclipAnalyzeWindow.mock.calls.map((call) => call[0] as VClipWindowRequest);
		expect(new Set(requests.map((request) => request.jobId)).size).toBe(1);
		expect(requests[0]).toMatchObject({
			sourcePath: source.originalPath,
			title: source.label,
			model: null,
		});
	});

	it("asks the lightest installed vision model unless the user picked another", async () => {
		useVClipStore.setState({
			models: {
				available: true,
				baseUrl: "http://127.0.0.1:11434",
				error: null,
				models: [
					{ name: "qwen3-vl:4b", size: 3, parameterSize: "4.4B" },
					{ name: "qwen3-vl:8b", size: 6, parameterSize: "8.8B" },
				],
			},
		});
		await useVClipStore.getState().analyze(source);
		expect(api.vclipAnalyzeWindow.mock.calls[0][0].model).toBe("qwen3-vl:4b");
		expect(effectiveModel("qwen3-vl:8b", useVClipStore.getState().models)).toBe("qwen3-vl:8b");
		expect(effectiveModel("uninstalled", useVClipStore.getState().models)).toBe("qwen3-vl:4b");
		expect(effectiveModel(null, useVClipStore.getState().models)).toBeNull();
		expect(effectiveModel(undefined, null)).toBeNull();
	});

	it("stops on cancel, tells the main process, and keeps what it found", async () => {
		let release!: () => void;
		api.vclipAnalyzeWindow.mockImplementation(async (request: VClipWindowRequest) => {
			if (request.startSec === 10)
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			return { success: true, result: analysis(request) };
		});
		const running = useVClipStore.getState().analyze(source);
		await vi.waitFor(() => expect(api.vclipAnalyzeWindow).toHaveBeenCalledTimes(3));
		useVClipStore.getState().cancel(source.id);
		const jobId = useVClipStore.getState().runs[key].jobId;
		expect(api.vclipCancel).toHaveBeenCalledWith(jobId);
		release();
		await running;
		const run = useVClipStore.getState().runs[key];
		expect(run.status).toBe("canceled");
		// The two windows done before the cancel, ranked; the one in flight is dropped.
		expect(run.segments.map((segment) => segment.startSec)).toEqual([0, 5]);
		expect(run.segments.every((segment) => segment.selected)).toBe(true);
		expect(api.vclipAnalyzeWindow).toHaveBeenCalledTimes(3);
	});

	it("stops when the project changes under it", async () => {
		api.vclipAnalyzeWindow.mockImplementation(async (request: VClipWindowRequest) => {
			if (request.startSec === 5) useProjectStore.setState({ projectId: "other" });
			return { success: true, result: analysis(request) };
		});
		await useVClipStore.getState().analyze(source);
		expect(useVClipStore.getState().runs[key].status).toBe("canceled");
		expect(api.vclipAnalyzeWindow).toHaveBeenCalledTimes(2);
		expect(api.vclipCancel).toHaveBeenCalled();
	});

	it("skips unreadable windows, and fails only when none could be read", async () => {
		api.vclipAnalyzeWindow.mockImplementation(async (request: VClipWindowRequest) =>
			request.startSec === 5
				? { success: false, error: "Could not read a frame at 6.00 s" }
				: { success: true, result: analysis(request) },
		);
		await useVClipStore.getState().analyze(source);
		let run = useVClipStore.getState().runs[key];
		expect(run.status).toBe("done");
		expect(run.unreadable).toBe(1);
		expect(run.segments).toHaveLength(3);

		api.vclipAnalyzeWindow.mockResolvedValue({ success: false, error: "moov atom not found" });
		await useVClipStore.getState().analyze(source);
		run = useVClipStore.getState().runs[key];
		expect(run.status).toBe("failed");
		expect(run.error).toBe("moov atom not found");
	});

	it("fails without analysing when the source cannot be probed", async () => {
		api.vclipProbe.mockResolvedValue({ success: false, error: "Choose an imported video first" });
		await useVClipStore.getState().analyze(source);
		expect(useVClipStore.getState().runs[key]).toMatchObject({
			status: "failed",
			error: "Choose an imported video first",
		});
		expect(api.vclipAnalyzeWindow).not.toHaveBeenCalled();
	});
});

describe("effects", () => {
	it("resolves random per segment, the same way every time, and honours a segment's own pick", () => {
		const run = { effect: "random" as const, effects: {}, seed: "seed" };
		const first = segmentEffect(run, "0.00-5.00");
		expect(first).not.toBe("random");
		expect(segmentEffect(run, "0.00-5.00")).toBe(first);
		expect(segmentEffect({ ...run, effects: { "0.00-5.00": "fade" } }, "0.00-5.00")).toBe("fade");
		expect(segmentEffect({ ...run, effect: "none" }, "5.00-10.00")).toBe("none");
	});
});

describe("createClips", () => {
	beforeEach(async () => {
		useVClipStore.setState({ segmentSec: 5, model: null });
		await useVClipStore.getState().analyze(source);
	});

	it("renders the selected segments in filmed order and places each on the timeline", async () => {
		mocks.addEffectClip.mockImplementation(
			async (request: { startMs: number }) => `clip-${request.startMs}`,
		);
		const onAdd = vi.fn(async () => undefined);
		useVClipStore.getState().setEffect(source.id, "zoom-in");
		await useVClipStore.getState().createClips(source, onAdd);
		expect(mocks.addEffectClip.mock.calls.map((call) => call[0])).toEqual([
			expect.objectContaining({
				startMs: 5000,
				endMs: 10000,
				effect: "zoom-in",
				width: 3840,
				height: 2160,
			}),
			expect.objectContaining({ startMs: 10000, endMs: 15000 }),
			expect.objectContaining({ startMs: 15000, endMs: 20000 }),
		]);
		expect(onAdd.mock.calls.map((call) => (call as unknown as [string])[0])).toEqual([
			"clip-5000",
			"clip-10000",
			"clip-15000",
		]);
		const run = useVClipStore.getState().runs[key];
		expect(Object.values(run.created)).toHaveLength(3);
		expect(run.creating).toBeNull();
		expect(mocks.toastSuccess).toHaveBeenCalledWith("V.Clip 클립 3개를 타임라인에 추가했습니다.");

		// Nothing left to make: a second press does not duplicate clips.
		await useVClipStore.getState().createClips(source, onAdd);
		expect(mocks.addEffectClip).toHaveBeenCalledTimes(3);
	});

	it("stops without placing anything once a render is superseded", async () => {
		mocks.addEffectClip.mockResolvedValue(null);
		const onAdd = vi.fn(async () => undefined);
		await useVClipStore.getState().createClips(source, onAdd);
		expect(mocks.addEffectClip).toHaveBeenCalledTimes(1);
		expect(onAdd).not.toHaveBeenCalled();
		expect(mocks.toastSuccess).not.toHaveBeenCalled();
	});

	it("reports how far it got when a render fails", async () => {
		mocks.addEffectClip
			.mockResolvedValueOnce("clip-a")
			.mockRejectedValueOnce(new Error("Clip effects need Google Chrome or Microsoft Edge."));
		await useVClipStore.getState().createClips(source, async () => undefined);
		expect(mocks.toastError).toHaveBeenCalledWith("클립 1개를 추가한 뒤 멈췄습니다.", {
			description: "Clip effects need Google Chrome or Microsoft Edge.",
		});
		const run = useVClipStore.getState().runs[key];
		expect(Object.keys(run.created)).toHaveLength(1);
		expect(run.creating).toBeNull();
	});
});
