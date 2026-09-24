import {
	ArrowRight,
	Film,
	Plus,
	RefreshCw,
	ScanSearch,
	Scissors,
	Shuffle,
	WandSparkles,
	X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { toFileUrl } from "@/components/video-editor/projectPersistence";
import type { AxcutAsset } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { formatSec, formatSeconds } from "@/lib/ai-edition/timeline/format";
import { audioFitSummary } from "@/lib/clip-effects/audioFit";
import { CLIP_EFFECTS, type ClipEffectSelection } from "@/lib/clip-effects/catalog";
import { type VClipProbeResult, vclipCategoryLabel } from "@/lib/vclip/contract";
import { selectedDurationSec, selectionToFill, type VClipSegment } from "@/lib/vclip/segments";
import {
	clipEffectLabel,
	effectiveModel,
	segmentEffect,
	useVClipStore,
	type VClipRun,
	vclipKey,
} from "@/lib/vclip/store";
import { ClipPreview } from "./ClipPreview";
import { MediaClipBuilder } from "./MediaClipBuilder";
import styles from "./VClipStage.module.css";

function basename(path: string): string {
	return path.split(/[\\/]/).pop() ?? path;
}

/** A clip this app rendered (userData/media/clip-effects): V.Clip's output, not footage. */
function isRenderedClip(asset: AxcutAsset): boolean {
	return /[\\/]media[\\/]clip-effects[\\/]/.test(asset.originalPath);
}

function EffectOptions() {
	return (
		<>
			<option value="none">효과 없음</option>
			<option value="random">랜덤 적용</option>
			{CLIP_EFFECTS.map((item) => (
				<option key={item.id} value={item.id}>
					{item.label}
				</option>
			))}
		</>
	);
}

/**
 * V.Clip — the step between Audio and Media that turns long source footage into clips:
 * split automatically (a local Ollama vision model scores each window, AutoVeo-style) or cut
 * by hand, each with a Remotion effect, then placed on the timeline.
 */
export function VClipStage({
	onAddToTimeline,
	onContinue,
}: {
	onAddToTimeline: (assetId: string) => Promise<void>;
	onContinue: () => void;
}) {
	const document = useProjectStore((state) => state.document);
	const projectId = useProjectStore((state) => state.projectId);
	const sourceId = useVClipStore((state) => state.sourceId);
	const [importing, setImporting] = useState(false);
	// Rendered clips would pile up here with every batch; one opened from Media still shows.
	const sources = useMemo(
		() =>
			(document?.assets ?? []).filter(
				(asset) => asset.kind !== "audio" && (!isRenderedClip(asset) || asset.id === sourceId),
			),
		[document?.assets, sourceId],
	);
	const selected = sources.find((asset) => asset.id === sourceId) ?? sources[0] ?? null;
	const fit = document ? audioFitSummary(document) : null;

	useEffect(() => {
		if (!useVClipStore.getState().models) void useVClipStore.getState().loadModels();
	}, []);

	const importVideo = async () => {
		if (!projectId || importing) return;
		setImporting(true);
		try {
			const picker = await window.electronAPI?.openVideoFilePicker();
			if (!picker?.success || !picker.path) return;
			if (useProjectStore.getState().projectId !== projectId) return;
			const label = picker.name || basename(picker.path);
			const asset = await useProjectStore.getState().addAsset(picker.path, label);
			if (!asset) return;
			useVClipStore.getState().selectSource(asset.id);
			toast.success(`${label} 영상을 추가했습니다.`);
		} catch (error) {
			toast.error("영상을 가져오지 못했습니다.", {
				description: error instanceof Error ? error.message : String(error),
			});
		} finally {
			setImporting(false);
		}
	};

	const importButton = (
		<button
			type="button"
			className={styles.button}
			disabled={!projectId || importing}
			onClick={() => void importVideo()}
		>
			<Plus size={15} />
			{importing ? "영상 준비 중…" : "영상 가져오기"}
		</button>
	);

	return (
		<div className={styles.stage}>
			<div className={styles.inner}>
				<header className={styles.header}>
					<div>
						<h1>V.Clip</h1>
						<p className={styles.hint}>
							긴 촬영 영상을 쓸 만한 구간으로 나눠 클립으로 만듭니다. Ollama 비전 모델이 장면을 보고
							점수와 설명을 붙이고, 모델이 없으면 선명도·밝기·흔들림으로 고릅니다.
						</p>
					</div>
					<button
						type="button"
						className={`${styles.button} ${styles.primary}`}
						onClick={onContinue}
					>
						Media로 이동 <ArrowRight size={15} />
					</button>
				</header>
				{fit && fit.audioMs > 0 ? (
					<p className={styles.fit}>
						Audio {formatSeconds(fit.audioMs / 1000)} · 타임라인 영상{" "}
						{formatSeconds(fit.pictureMs / 1000)} ·{" "}
						<strong>남은 {formatSeconds(fit.remainingMs / 1000)}</strong>
					</p>
				) : null}
				{!document ? (
					<div className={styles.empty}>
						<Film size={32} />
						<p className={styles.hint}>프로젝트를 먼저 만들거나 열어 주세요.</p>
					</div>
				) : sources.length === 0 ? (
					<div className={styles.empty}>
						<Film size={32} />
						<strong>나눌 영상을 가져오세요</strong>
						<p className={styles.hint}>드론·카메라로 찍은 긴 영상일수록 V.Clip이 유용합니다.</p>
						{importButton}
					</div>
				) : (
					<div className={styles.columns}>
						<aside className={styles.sources} aria-label="소스 영상">
							{sources.map((asset) => (
								<button
									type="button"
									key={asset.id}
									className={styles.source}
									aria-pressed={asset.id === selected?.id}
									title={asset.originalPath}
									onClick={() => useVClipStore.getState().selectSource(asset.id)}
								>
									<Film size={18} />
									<span className={styles.sourceText}>
										<strong>{asset.label || basename(asset.originalPath)}</strong>
										<SourceStatus projectId={projectId} asset={asset} />
									</span>
								</button>
							))}
							{importButton}
						</aside>
						{selected ? (
							<SourceWorkspace
								key={vclipKey(projectId, selected.id)}
								source={selected}
								onAddToTimeline={onAddToTimeline}
							/>
						) : null}
					</div>
				)}
			</div>
		</div>
	);
}

function SourceStatus({ projectId, asset }: { projectId: string | null; asset: AxcutAsset }) {
	const key = vclipKey(projectId, asset.id);
	const run = useVClipStore((state) => state.runs[key]);
	// An import's length is only known once something has read the file; FFmpeg may have.
	const probed = useVClipStore((state) => state.probes[key]?.durationSec);
	const duration = formatSeconds(asset.durationSec || probed || 0);
	if (run?.status === "analyzing")
		return <span>분석 중 {`${run.completed}/${run.total || "…"}`}</span>;
	if (run && run.segments.length > 0)
		return (
			<span>
				{duration} · 구간 {run.segments.length}개
			</span>
		);
	return <span>{duration}</span>;
}

function describeProbe(probe: VClipProbeResult | undefined): string {
	if (!probe) return "영상 정보 읽는 중…";
	if (!probe.success) return probe.error || "영상 정보를 읽지 못했습니다.";
	return [
		formatSeconds(probe.durationSec ?? 0),
		`${probe.width}×${probe.height}`,
		probe.fps ? `${Math.round(probe.fps * 100) / 100} fps` : null,
		probe.hasAudio ? null : "소리 없음",
	]
		.filter(Boolean)
		.join(" · ");
}

function SourceWorkspace({
	source,
	onAddToTimeline,
}: {
	source: AxcutAsset;
	onAddToTimeline: (assetId: string) => Promise<void>;
}) {
	const projectId = useProjectStore((state) => state.projectId);
	const probe = useVClipStore((state) => state.probes[vclipKey(projectId, source.id)]);
	const [tab, setTab] = useState<"auto" | "manual">("auto");
	const [refine, setRefine] = useState<{ startMs: number; endMs: number } | null>(null);
	const { id, label, originalPath } = source;
	useEffect(() => {
		void useVClipStore.getState().probe({ id, label, originalPath });
	}, [id, label, originalPath]);
	const knownMetadata =
		probe?.success && probe.durationSec && probe.width && probe.height
			? {
					durationMs: Math.round(probe.durationSec * 1000),
					width: probe.width,
					height: probe.height,
				}
			: undefined;

	return (
		<section className={styles.workspace} aria-label="V.Clip 작업 영역">
			<div>
				<h2 className={styles.title} title={source.originalPath}>
					{source.label || basename(source.originalPath)}
				</h2>
				<p className={probe && !probe.success ? styles.error : styles.hint}>
					{describeProbe(probe)}
				</p>
			</div>
			<div className={styles.tabs} role="tablist" aria-label="클립 만드는 방법">
				<button
					type="button"
					role="tab"
					aria-selected={tab === "auto"}
					onClick={() => setTab("auto")}
				>
					<ScanSearch size={15} />
					자동 분할
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={tab === "manual"}
					onClick={() => {
						setRefine(null);
						setTab("manual");
					}}
				>
					<Scissors size={15} />
					직접 자르기
				</button>
			</div>
			{tab === "auto" ? (
				<AutoSplitPanel
					source={source}
					probe={probe}
					onAddToTimeline={onAddToTimeline}
					onRefine={(range) => {
						setRefine(range);
						setTab("manual");
					}}
				/>
			) : probe ? (
				// Mounted once FFmpeg has answered, so its metadata never arrives mid-edit. A failed
				// probe leaves the builder to the browser's own.
				<MediaClipBuilder
					key={refine ? `${refine.startMs}-${refine.endMs}` : "whole"}
					asset={source}
					onAddToTimeline={onAddToTimeline}
					initialRange={refine ?? undefined}
					knownMetadata={knownMetadata}
				/>
			) : (
				<p className={styles.hint}>영상 정보 읽는 중…</p>
			)}
		</section>
	);
}

function ollamaStatus(
	models: ReturnType<typeof useVClipStore.getState>["models"],
	loading: boolean,
): string {
	if (loading || !models) return "Ollama 확인 중…";
	if (!models.available)
		return `Ollama에 연결할 수 없어 화질 점수만으로 고릅니다.${models.error ? ` (${models.error})` : ""}`;
	if (models.models.length === 0)
		return "Ollama에 비전 모델이 없어 화질 점수만으로 고릅니다. 'ollama pull qwen3-vl:4b'로 설치하면 장면 설명과 점수를 받을 수 있습니다.";
	return `Ollama 연결됨 · 비전 모델 ${models.models.length}개. 작은 모델일수록 빠릅니다.`;
}

function AutoSplitPanel({
	source,
	probe,
	onAddToTimeline,
	onRefine,
}: {
	source: AxcutAsset;
	probe: VClipProbeResult | undefined;
	onAddToTimeline: (assetId: string) => Promise<void>;
	onRefine: (range: { startMs: number; endMs: number }) => void;
}) {
	const projectId = useProjectStore((state) => state.projectId);
	const document = useProjectStore((state) => state.document);
	const run = useVClipStore((state) => state.runs[vclipKey(projectId, source.id)]);
	const segmentSec = useVClipStore((state) => state.segmentSec);
	const chosenModel = useVClipStore((state) => state.model);
	const models = useVClipStore((state) => state.models);
	const modelsLoading = useVClipStore((state) => state.modelsLoading);
	const [previewId, setPreviewId] = useState<string | null>(null);
	const previewRef = useRef<HTMLDivElement>(null);
	const store = useVClipStore.getState();
	const model = effectiveModel(chosenModel, models);
	const analyzing = run?.status === "analyzing";
	const creating = run?.creating ?? null;
	const segments = run?.segments ?? [];
	const pending = segments.filter((segment) => segment.selected && !run?.created[segment.id]);
	const fit = document ? audioFitSummary(document) : null;
	const previewSegment = segments.find((segment) => segment.id === previewId) ?? null;
	const validSegmentSec = Number.isFinite(segmentSec) && segmentSec >= 2 && segmentSec <= 20;
	const aiFailures = segments.filter((segment) => segment.aiError);
	// A finished analysis re-ranks and preselects, so picks made while it runs would be lost.
	const selectionLocked = analyzing || Boolean(creating);

	useEffect(() => {
		if (previewId) previewRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
	}, [previewId]);

	return (
		<div className={styles.panel}>
			<div className={styles.settings}>
				<label>
					구간 길이 (초)
					<input
						type="number"
						aria-label="구간 길이 (초)"
						min={2}
						max={20}
						step={0.5}
						value={Number.isFinite(segmentSec) ? segmentSec : ""}
						disabled={analyzing}
						onChange={(event) => store.setSegmentSec(event.target.valueAsNumber)}
					/>
				</label>
				<label>
					분석 모델
					<select
						aria-label="분석 모델"
						value={model ?? ""}
						disabled={analyzing}
						onChange={(event) => store.setModel(event.target.value || null)}
					>
						{models?.models.map((item) => (
							<option key={item.name} value={item.name}>
								{item.name}
								{item.parameterSize ? ` · ${item.parameterSize}` : ""}
							</option>
						))}
						<option value="">AI 없이 (화질 점수만)</option>
					</select>
				</label>
				<button
					type="button"
					className={styles.iconButton}
					title="Ollama 모델 다시 확인"
					aria-label="Ollama 모델 다시 확인"
					disabled={modelsLoading || analyzing}
					onClick={() => void store.loadModels()}
				>
					<RefreshCw size={15} className={modelsLoading ? "animate-spin" : undefined} />
				</button>
			</div>
			<p className={styles.hint}>{ollamaStatus(models, modelsLoading)}</p>
			{!validSegmentSec ? (
				<p className={styles.error}>구간 길이는 2~20초 사이로 입력하세요.</p>
			) : null}

			<div className={styles.row}>
				{analyzing ? (
					<button type="button" className={styles.button} onClick={() => store.cancel(source.id)}>
						<X size={15} />
						분석 멈추기
					</button>
				) : (
					<button
						type="button"
						className={`${styles.button} ${styles.primary}`}
						// Until Ollama has answered, a run would quietly go without the model.
						disabled={
							!validSegmentSec ||
							Boolean(creating) ||
							probe?.success === false ||
							!models ||
							modelsLoading
						}
						onClick={() => void store.analyze(source)}
					>
						<ScanSearch size={15} />
						{run ? "구간 다시 찾기" : "구간 찾기"}
					</button>
				)}
				{analyzing && run ? (
					<div
						className={styles.progress}
						role="progressbar"
						aria-label="구간 분석"
						aria-valuemin={0}
						aria-valuemax={run.total || 1}
						aria-valuenow={run.completed}
					>
						<span style={{ width: `${run.total ? (run.completed / run.total) * 100 : 0}%` }} />
					</div>
				) : null}
				{analyzing && run ? (
					<span className={styles.hint}>
						{run.total ? `구간 분석 ${run.completed} / ${run.total}` : "영상 정보 읽는 중…"}
					</span>
				) : null}
			</div>

			{run ? <RunNotes run={run} aiFailures={aiFailures} /> : null}
			{!run ? (
				<p className={styles.hint}>
					‘구간 찾기’를 누르면 영상 전체에 고르게 퍼진 구간 최대 12개를 뽑아 점수를 매기고, 서로
					많이 겹치는 구간은 점수가 낮은 쪽을 뺍니다. 가장 좋은 3개가 먼저 선택됩니다.
				</p>
			) : null}

			{segments.length > 0 && run ? (
				<>
					{probe?.success && probe.durationSec ? (
						<SegmentTrack segments={segments} durationSec={probe.durationSec} />
					) : null}
					<div className={styles.row}>
						<span className={styles.summary}>
							선택 {segments.filter((segment) => segment.selected).length}개 ·{" "}
							{formatSec(selectedDurationSec(segments))}
						</span>
						{fit && fit.remainingMs > 0 ? (
							<button
								type="button"
								className={styles.button}
								disabled={selectionLocked}
								onClick={() =>
									store.setSelection(
										source.id,
										selectionToFill(
											segments.filter((segment) => !run.created[segment.id]),
											fit.remainingMs / 1000,
										),
									)
								}
							>
								남은 Audio만큼 선택
							</button>
						) : null}
						<button
							type="button"
							className={styles.button}
							disabled={selectionLocked}
							onClick={() =>
								store.setSelection(source.id, new Set(segments.map((segment) => segment.id)))
							}
						>
							모두 선택
						</button>
						<button
							type="button"
							className={styles.button}
							disabled={selectionLocked}
							onClick={() => store.setSelection(source.id, new Set())}
						>
							선택 해제
						</button>
					</div>
					<div className={styles.row}>
						<label className={styles.inline}>
							Remotion 효과
							<select
								aria-label="Remotion 효과"
								value={run.effect}
								disabled={Boolean(creating)}
								onChange={(event) =>
									store.setEffect(source.id, event.target.value as ClipEffectSelection)
								}
							>
								<EffectOptions />
							</select>
						</label>
						{run.effect === "random" ||
						Object.values(run.effects).some((effect) => effect === "random") ? (
							<button
								type="button"
								className={styles.button}
								disabled={Boolean(creating)}
								onClick={() => store.reshuffle(source.id)}
							>
								<Shuffle size={14} />
								랜덤 다시 섞기
							</button>
						) : null}
					</div>
					{previewSegment && probe?.success && probe.width && probe.height ? (
						<div ref={previewRef} className={styles.preview}>
							<div className={styles.previewHead}>
								<strong>
									미리보기 · {formatSec(previewSegment.startSec)}–{formatSec(previewSegment.endSec)}{" "}
									· {clipEffectLabel(segmentEffect(run, previewSegment.id))}
								</strong>
								<button
									type="button"
									className={styles.iconButton}
									aria-label="미리보기 닫기"
									onClick={() => setPreviewId(null)}
								>
									<X size={15} />
								</button>
							</div>
							<ClipPreview
								sourceUrl={toFileUrl(source.originalPath)}
								startMs={Math.round(previewSegment.startSec * 1000)}
								endMs={Math.round(previewSegment.endSec * 1000)}
								effect={segmentEffect(run, previewSegment.id)}
								width={probe.width}
								height={probe.height}
							/>
						</div>
					) : null}
					<div className={styles.grid}>
						{segments.map((segment) => (
							<SegmentCard
								key={segment.id}
								segment={segment}
								run={run}
								busy={Boolean(creating)}
								selectionLocked={selectionLocked}
								previewing={segment.id === previewId}
								onPreview={() => setPreviewId(segment.id === previewId ? null : segment.id)}
								onToggle={() => store.toggleSegment(source.id, segment.id)}
								onEffect={(effect) => store.setSegmentEffect(source.id, segment.id, effect)}
								onRefine={() =>
									onRefine({
										startMs: Math.round(segment.startSec * 1000),
										endMs: Math.round(segment.endSec * 1000),
									})
								}
							/>
						))}
					</div>
					<button
						type="button"
						className={`${styles.button} ${styles.primary} ${styles.create}`}
						disabled={pending.length === 0 || Boolean(creating) || analyzing}
						onClick={() => void store.createClips(source, onAddToTimeline)}
					>
						<WandSparkles size={15} />
						{creating
							? `클립 만드는 중 ${Math.min(creating.done + 1, creating.total)} / ${creating.total}…`
							: pending.length === 0 && segments.some((segment) => segment.selected)
								? "선택한 구간은 모두 클립으로 만들었습니다"
								: `선택한 구간 ${pending.length}개를 클립으로 만들고 타임라인에 추가`}
					</button>
					<p className={styles.hint}>
						원본은 그대로 두고 구간마다 새 클립 파일을 만듭니다. 만든 클립은 Media 목록에도
						추가되고, 촬영 순서대로 타임라인 끝에 붙습니다.
					</p>
				</>
			) : null}
		</div>
	);
}

function RunNotes({ run, aiFailures }: { run: VClipRun; aiFailures: VClipSegment[] }) {
	return (
		<>
			{run.status === "failed" ? (
				<p role="alert" className={styles.error}>
					구간을 찾지 못했습니다: {run.error}
				</p>
			) : null}
			{run.status === "canceled" ? (
				<p className={styles.hint}>분석을 멈췄습니다. 그때까지 찾은 구간만 보여 줍니다.</p>
			) : null}
			{run.unreadable > 0 && run.status !== "failed" ? (
				<p className={styles.hint}>{run.unreadable}개 구간은 영상을 읽지 못해 건너뛰었습니다.</p>
			) : null}
			{aiFailures.length > 0 ? (
				<p className={styles.warn} title={aiFailures[0].aiError ?? undefined}>
					AI가 {aiFailures.length}개 구간을 판단하지 못해 화질 점수로 대신했습니다.
				</p>
			) : null}
		</>
	);
}

function SegmentTrack({
	segments,
	durationSec,
}: {
	segments: VClipSegment[];
	durationSec: number;
}) {
	return (
		<div className={styles.track} aria-hidden>
			{segments.map((segment) => (
				<span
					key={segment.id}
					data-selected={segment.selected}
					style={{
						left: `${(segment.startSec / durationSec) * 100}%`,
						width: `${((segment.endSec - segment.startSec) / durationSec) * 100}%`,
					}}
				/>
			))}
		</div>
	);
}

function SegmentCard({
	segment,
	run,
	busy,
	selectionLocked,
	previewing,
	onPreview,
	onToggle,
	onEffect,
	onRefine,
}: {
	segment: VClipSegment;
	run: VClipRun;
	/** Clips are being rendered: their effects are fixed. */
	busy: boolean;
	selectionLocked: boolean;
	previewing: boolean;
	onPreview: () => void;
	onToggle: () => void;
	onEffect: (effect: ClipEffectSelection | null) => void;
	onRefine: () => void;
}) {
	const range = `${formatSec(segment.startSec)}–${formatSec(segment.endSec)}`;
	const created = Boolean(run.created[segment.id]);
	const inherited = clipEffectLabel(segmentEffect({ ...run, effects: {} }, segment.id));
	return (
		<article className={styles.card} data-selected={segment.selected} aria-label={`구간 ${range}`}>
			<div className={styles.thumb}>
				{segment.thumbnail ? (
					<img src={segment.thumbnail} alt="" draggable={false} />
				) : (
					<Film size={28} />
				)}
				<span className={styles.score} title={segment.ai ? "AI 점수" : "화질 점수"}>
					{segment.score}
				</span>
				<span className={styles.time}>
					{range} · {(segment.endSec - segment.startSec).toFixed(1)}초
				</span>
			</div>
			<div className={styles.cardBody}>
				<div className={styles.chips}>
					<span className={styles.chip}>
						{segment.ai ? vclipCategoryLabel(segment.ai.category) : "화질 점수"}
					</span>
					{segment.ai ? (
						<span className={`${styles.chip} ${styles.quiet}`} title="선명도·밝기·흔들림 점수">
							화질 {segment.qualityScore}
						</span>
					) : null}
					{created ? <span className={`${styles.chip} ${styles.done}`}>클립 완성</span> : null}
				</div>
				<p className={styles.reason}>{segment.reason}</p>
				{segment.ai?.caption ? <p className={styles.caption}>“{segment.ai.caption}”</p> : null}
				{segment.ai?.tags.length ? (
					<p className={styles.tags}>{segment.ai.tags.map((tag) => `#${tag}`).join(" ")}</p>
				) : null}
				<label className={styles.inline}>
					효과
					<select
						aria-label={`${range} 구간 효과`}
						value={run.effects[segment.id] ?? "inherit"}
						disabled={busy}
						onChange={(event) =>
							onEffect(
								event.target.value === "inherit"
									? null
									: (event.target.value as ClipEffectSelection),
							)
						}
					>
						<option value="inherit">기본 ({inherited})</option>
						<EffectOptions />
					</select>
				</label>
				<div className={styles.cardActions}>
					<button type="button" aria-pressed={previewing} onClick={onPreview}>
						미리보기
					</button>
					<button type="button" onClick={onRefine}>
						구간 다듬기
					</button>
					<button
						type="button"
						className={segment.selected ? undefined : styles.primary}
						aria-pressed={segment.selected}
						disabled={selectionLocked}
						onClick={onToggle}
					>
						{segment.selected ? "빼기" : "넣기"}
					</button>
				</div>
			</div>
		</article>
	);
}
