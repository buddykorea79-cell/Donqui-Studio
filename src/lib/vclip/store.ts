import { toast } from "sonner";
import { create } from "zustand";
import type { AxcutAsset } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { addEffectClip } from "@/lib/clip-effects/addEffectClip";
import {
	CLIP_EFFECTS,
	type ClipEffectId,
	type ClipEffectSelection,
	resolveClipEffect,
} from "@/lib/clip-effects/catalog";
import {
	VCLIP_SEGMENT_LIMITS,
	type VClipModelList,
	type VClipProbeResult,
	type VClipWindowAnalysis,
	type VClipWindowResult,
} from "./contract";
import {
	candidateWindows,
	clampSegmentSec,
	provisionalSegments,
	rankSegments,
	type VClipSegment,
} from "./segments";

/**
 * V.Clip's working state: which source is open, what analysing it found, and which of the
 * found segments become clips. It lives outside the stage component so an analysis keeps
 * running — and its results stay — while the user looks at another tab. Runs are keyed by
 * project and asset, and a run stops itself when the project changes under it.
 */

export type VClipSource = Pick<AxcutAsset, "id" | "label" | "originalPath">;

export interface VClipRun {
	jobId: string;
	status: "analyzing" | "done" | "canceled" | "failed";
	/** Windows analysed so far, of `total`. */
	completed: number;
	total: number;
	/** The model this run asked, or null for frame quality alone. */
	model: string | null;
	segments: VClipSegment[];
	/** Windows FFmpeg could not read; the run carries on without them. */
	unreadable: number;
	error: string | null;
	/** Effect for every selected segment, unless a segment has its own in `effects`. */
	effect: ClipEffectSelection;
	effects: Record<string, ClipEffectSelection>;
	/** Seeds the random picks, so the preview shows what the render will produce. */
	seed: string;
	/** Clip asset made from each segment. */
	created: Record<string, string>;
	creating: { done: number; total: number } | null;
}

interface VClipState {
	sourceId: string | null;
	segmentSec: number;
	/** The chosen model; undefined until the user picks, which means the lightest one. */
	model: string | null | undefined;
	models: VClipModelList | null;
	modelsLoading: boolean;
	probes: Record<string, VClipProbeResult>;
	runs: Record<string, VClipRun>;

	selectSource: (assetId: string | null) => void;
	setSegmentSec: (value: number) => void;
	setModel: (model: string | null) => void;
	loadModels: () => Promise<void>;
	probe: (source: VClipSource) => Promise<VClipProbeResult>;
	analyze: (source: VClipSource) => Promise<void>;
	cancel: (assetId: string) => void;
	toggleSegment: (assetId: string, segmentId: string) => void;
	setSelection: (assetId: string, segmentIds: ReadonlySet<string>) => void;
	setEffect: (assetId: string, effect: ClipEffectSelection) => void;
	setSegmentEffect: (
		assetId: string,
		segmentId: string,
		effect: ClipEffectSelection | null,
	) => void;
	reshuffle: (assetId: string) => void;
	createClips: (
		source: VClipSource,
		onAddToTimeline: (assetId: string) => Promise<void>,
	) => Promise<void>;
}

export function vclipKey(projectId: string | null, assetId: string): string {
	return `${projectId ?? ""}:${assetId}`;
}

function currentKey(assetId: string): string | null {
	const projectId = useProjectStore.getState().projectId;
	return projectId ? vclipKey(projectId, assetId) : null;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The model a new run asks: the user's pick, else the lightest installed vision model. */
export function effectiveModel(
	chosen: string | null | undefined,
	models: VClipModelList | null,
): string | null {
	const installed = models?.models ?? [];
	if (chosen === null) return null;
	if (chosen !== undefined && installed.some((model) => model.name === chosen)) return chosen;
	return installed[0]?.name ?? null;
}

/** What a segment will be rendered with — the same answer for its preview and its clip. */
export function segmentEffect(
	run: Pick<VClipRun, "effect" | "effects" | "seed">,
	segmentId: string,
): ClipEffectId {
	return resolveClipEffect(run.effects[segmentId] ?? run.effect, `${run.seed}:${segmentId}`);
}

export function clipEffectLabel(effect: ClipEffectId): string {
	return CLIP_EFFECTS.find((item) => item.id === effect)?.label ?? "효과 없음";
}

export const useVClipStore = create<VClipState>((set, get) => {
	/** Updates one run, if it is still there. */
	const patch = (key: string, update: (run: VClipRun) => Partial<VClipRun>) =>
		set((state) => {
			const run = state.runs[key];
			return run ? { runs: { ...state.runs, [key]: { ...run, ...update(run) } } } : {};
		});

	/** Ends an analysis, keeping what it found — ranked and preselected, as a finished one. */
	const stopRun = (key: string, status: VClipRun["status"], error: string | null = null) =>
		patch(key, (run) => ({
			status,
			error,
			segments: rankSegments(run.segments),
		}));

	return {
		sourceId: null,
		segmentSec: VCLIP_SEGMENT_LIMITS.defaultSec,
		model: undefined,
		models: null,
		modelsLoading: false,
		probes: {},
		runs: {},

		selectSource: (assetId) => set({ sourceId: assetId }),
		setSegmentSec: (value) => set({ segmentSec: value }),
		setModel: (model) => set({ model }),

		async loadModels() {
			if (get().modelsLoading) return;
			const list = window.electronAPI?.vclipListModels;
			if (!list) {
				set({
					models: {
						available: false,
						baseUrl: "",
						error: "V.Clip은 Donqui Studio 데스크톱 앱에서 사용할 수 있습니다.",
						models: [],
					},
				});
				return;
			}
			set({ modelsLoading: true });
			try {
				set({ models: await list() });
			} catch (error) {
				set({ models: { available: false, baseUrl: "", error: message(error), models: [] } });
			} finally {
				set({ modelsLoading: false });
			}
		},

		async probe(source) {
			const key = currentKey(source.id);
			const cached = key ? get().probes[key] : undefined;
			if (cached?.success) return cached;
			const probe = window.electronAPI?.vclipProbe;
			const result: VClipProbeResult = probe
				? await probe(source.originalPath).catch(
						(error: unknown): VClipProbeResult => ({ success: false, error: message(error) }),
					)
				: { success: false, error: "V.Clip은 Donqui Studio 데스크톱 앱에서 사용할 수 있습니다." };
			if (key && currentKey(source.id) === key)
				set((state) => ({ probes: { ...state.probes, [key]: result } }));
			return result;
		},

		async analyze(source) {
			const projectId = useProjectStore.getState().projectId;
			const analyzeWindow = window.electronAPI?.vclipAnalyzeWindow;
			if (!projectId || !analyzeWindow) return;
			const key = vclipKey(projectId, source.id);
			const previous = get().runs[key];
			if (previous?.status === "analyzing" || previous?.creating) return;
			const { segmentSec, model: chosen, models } = get();
			const model = effectiveModel(chosen, models);
			const jobId = crypto.randomUUID();
			set((state) => ({
				runs: {
					...state.runs,
					[key]: {
						jobId,
						status: "analyzing",
						completed: 0,
						total: 0,
						model,
						segments: [],
						unreadable: 0,
						error: null,
						// The effect choice outlives a re-run; what it applied to does not.
						effect: previous?.effect ?? "none",
						effects: {},
						seed: previous?.seed ?? crypto.randomUUID(),
						created: {},
						creating: null,
					},
				},
			}));
			const ours = () => {
				const run = get().runs[key];
				return run?.jobId === jobId && run.status === "analyzing";
			};

			const probe = await get().probe(source);
			if (!ours()) return;
			if (!probe.success || !probe.durationSec) {
				stopRun(key, "failed", probe.error || "영상 길이를 읽지 못했습니다.");
				return;
			}
			const windows = candidateWindows(probe.durationSec, clampSegmentSec(segmentSec));
			patch(key, () => ({ total: windows.length }));

			const analyses: VClipWindowAnalysis[] = [];
			let firstError: string | null = null;
			for (const span of windows) {
				if (useProjectStore.getState().projectId !== projectId) {
					stopRun(key, "canceled");
					void window.electronAPI?.vclipCancel?.(jobId);
					return;
				}
				const result = await analyzeWindow({
					jobId,
					sourcePath: source.originalPath,
					startSec: span.startSec,
					endSec: span.endSec,
					model,
					title: source.label,
				}).catch(
					(error: unknown): VClipWindowResult => ({ success: false, error: message(error) }),
				);
				if (!ours()) return;
				if (result.success && result.result) analyses.push(result.result);
				else firstError ??= result.error ?? "구간을 읽지 못했습니다.";
				patch(key, (run) => ({
					completed: run.completed + 1,
					unreadable: run.unreadable + (result.success ? 0 : 1),
					segments: provisionalSegments(analyses),
				}));
			}
			if (analyses.length === 0) stopRun(key, "failed", firstError);
			else stopRun(key, "done");
		},

		cancel(assetId) {
			const key = currentKey(assetId);
			const run = key ? get().runs[key] : undefined;
			if (!key || run?.status !== "analyzing") return;
			stopRun(key, "canceled");
			void window.electronAPI?.vclipCancel?.(run.jobId);
		},

		toggleSegment(assetId, segmentId) {
			const key = currentKey(assetId);
			if (!key) return;
			patch(key, (run) => ({
				segments: run.segments.map((segment) =>
					segment.id === segmentId ? { ...segment, selected: !segment.selected } : segment,
				),
			}));
		},

		setSelection(assetId, segmentIds) {
			const key = currentKey(assetId);
			if (!key) return;
			patch(key, (run) => ({
				segments: run.segments.map((segment) => ({
					...segment,
					selected: segmentIds.has(segment.id),
				})),
			}));
		},

		setEffect(assetId, effect) {
			const key = currentKey(assetId);
			if (key) patch(key, () => ({ effect }));
		},

		setSegmentEffect(assetId, segmentId, effect) {
			const key = currentKey(assetId);
			if (!key) return;
			patch(key, (run) => {
				const effects = { ...run.effects };
				if (effect === null) delete effects[segmentId];
				else effects[segmentId] = effect;
				return { effects };
			});
		},

		reshuffle(assetId) {
			const key = currentKey(assetId);
			if (key) patch(key, () => ({ seed: crypto.randomUUID() }));
		},

		async createClips(source, onAddToTimeline) {
			const projectId = useProjectStore.getState().projectId;
			if (!projectId) return;
			const key = vclipKey(projectId, source.id);
			const run = get().runs[key];
			const probe = get().probes[key];
			if (!run || run.creating || run.status === "analyzing") return;
			if (!probe?.success || !probe.width || !probe.height) {
				toast.error("클립을 만들지 못했습니다.", { description: "영상 크기를 읽지 못했습니다." });
				return;
			}
			// Source order, so the clips land on the timeline in the order they were filmed.
			const targets = run.segments
				.filter((segment) => segment.selected && !run.created[segment.id])
				.sort((left, right) => left.startSec - right.startSec);
			if (targets.length === 0) return;
			patch(key, () => ({ creating: { done: 0, total: targets.length } }));
			let made = 0;
			try {
				for (const segment of targets) {
					const current = get().runs[key] ?? run;
					const effect = segmentEffect(current, segment.id);
					const startMs = Math.round(segment.startSec * 1000);
					const endMs = Math.round(segment.endSec * 1000);
					const clipId = await addEffectClip({
						sourcePath: source.originalPath,
						startMs,
						endMs,
						effect,
						width: probe.width,
						height: probe.height,
						label: `${source.label} · ${segment.startSec.toFixed(1)}–${segment.endSec.toFixed(1)}초 · ${clipEffectLabel(effect)}`,
					});
					// A project switch or an undo while rendering: keep nothing, and stop.
					if (!clipId) break;
					await onAddToTimeline(clipId);
					made++;
					patch(key, (latest) => ({
						created: { ...latest.created, [segment.id]: clipId },
						creating: { done: made, total: targets.length },
					}));
				}
				if (made > 0) toast.success(`V.Clip 클립 ${made}개를 타임라인에 추가했습니다.`);
			} catch (error) {
				toast.error(
					made > 0 ? `클립 ${made}개를 추가한 뒤 멈췄습니다.` : "클립을 만들지 못했습니다.",
					{ description: message(error) },
				);
			} finally {
				patch(key, () => ({ creating: null }));
			}
		},
	};
});
