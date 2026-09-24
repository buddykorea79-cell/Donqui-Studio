import { Shuffle, WandSparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { toFileUrl } from "@/components/video-editor/projectPersistence";
import type { AxcutAsset } from "@/lib/ai-edition/schema";
import { enqueueDocumentWrite } from "@/lib/ai-edition/store/documentWriteQueue";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { currentWriteEpoch } from "@/lib/ai-edition/store/undoStack";
import { probeVideoDimensions, probeVideoDuration } from "@/lib/ai-edition/timeline/duration";
import { audioFitSummary, fitClipEndMs } from "@/lib/clip-effects/audioFit";
import {
	CLIP_EFFECTS,
	type ClipEffectSelection,
	resolveClipEffect,
} from "@/lib/clip-effects/catalog";
import { ClipPreview } from "./ClipPreview";
import styles from "./MediaClipBuilder.module.css";

export function MediaClipBuilder({
	asset,
	onAddToTimeline,
}: {
	asset: AxcutAsset;
	onAddToTimeline: (assetId: string) => Promise<void>;
}) {
	const document = useProjectStore((state) => state.document);
	const projectId = useProjectStore((state) => state.projectId);
	const [metadata, setMetadata] = useState<{
		durationMs: number;
		width: number;
		height: number;
	} | null>(null);
	const [error, setError] = useState("");
	const [startMs, setStartMs] = useState(0);
	const [endMs, setEndMs] = useState(0);
	const [selection, setSelection] = useState<ClipEffectSelection>("none");
	const [seed, setSeed] = useState(() => crypto.randomUUID());
	const [busy, setBusy] = useState(false);
	const [preview, setPreview] = useState(false);
	const mounted = useRef(true);
	const busyRef = useRef(false);
	const sourceUrl = toFileUrl(asset.originalPath);
	const effect = resolveClipEffect(selection, seed);
	const effectLabel = CLIP_EFFECTS.find((item) => item.id === effect)?.label ?? "효과 없음";
	const fit = document ? audioFitSummary(document) : null;
	const validRange =
		metadata !== null &&
		Number.isFinite(startMs) &&
		Number.isFinite(endMs) &&
		startMs >= 0 &&
		endMs <= metadata.durationMs &&
		endMs - startMs >= 100 &&
		endMs - startMs <= 600_000;

	useEffect(() => {
		mounted.current = true;
		let active = true;
		void Promise.all([probeVideoDuration(sourceUrl), probeVideoDimensions(sourceUrl)])
			.then(([duration, dimensions]) => {
				if (!active) return;
				if (!duration || !dimensions) {
					setError("소스 정보를 읽을 수 없습니다. 원본 파일 위치를 확인해 주세요.");
					return;
				}
				const durationMs = Math.round(duration * 1000);
				setMetadata({ durationMs, ...dimensions });
				setEndMs(durationMs);
			})
			.catch((reason: unknown) => {
				if (active) setError(reason instanceof Error ? reason.message : String(reason));
			});
		return () => {
			active = false;
			mounted.current = false;
		};
	}, [sourceUrl]);

	async function createClip() {
		if (!metadata || !validRange || !projectId || busyRef.current) return;
		busyRef.current = true;
		const epoch = currentWriteEpoch();
		const superseded = () =>
			useProjectStore.getState().projectId !== projectId || currentWriteEpoch() !== epoch;
		setBusy(true);
		setError("");
		try {
			const create = window.electronAPI?.createClipEffect;
			if (!create)
				throw new Error("클립 만들기는 Donqui Studio 데스크톱 앱에서 사용할 수 있습니다.");
			const result = await create({
				sourcePath: asset.originalPath,
				startMs,
				endMs,
				effect,
				width: metadata.width,
				height: metadata.height,
			});
			if (!result.success || !result.filePath)
				throw new Error(result.error || "클립을 만들지 못했습니다.");
			if (superseded()) return;
			const created = await useProjectStore
				.getState()
				.addAsset(
					result.filePath,
					`${asset.label} · ${(startMs / 1000).toFixed(1)}–${(endMs / 1000).toFixed(1)}초 · ${effectLabel}`,
				);
			if (!created) throw new Error("만든 클립을 프로젝트에 저장하지 못했습니다.");
			if (superseded()) return;
			const saved = await enqueueDocumentWrite(async () => {
				if (superseded()) return false;
				const state = useProjectStore.getState();
				if (!state.document?.assets.some((item) => item.id === created.id)) return true;
				return state.saveDocument(
					{
						...state.document,
						assets: state.document.assets.map((item) =>
							item.id === created.id
								? {
										...item,
										durationSec: (result.durationMs ?? endMs - startMs) / 1000,
										video: {
											codec: "h264",
											fps: 30,
											width: result.width ?? metadata.width,
											height: result.height ?? metadata.height,
										},
									}
								: item,
						),
					},
					{ history: false },
				);
			});
			if (superseded()) return;
			if (!saved) throw new Error("클립 길이를 저장하지 못했습니다.");
			await onAddToTimeline(created.id);
			toast.success("효과를 적용한 클립을 타임라인에 추가했습니다.");
		} catch (reason) {
			if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			busyRef.current = false;
			if (mounted.current) setBusy(false);
		}
	}

	return (
		<section className={styles.builder} aria-label="클립 만들기">
			<p className={styles.hint}>사용할 구간(0.1초~10분)과 효과를 고른 뒤 미리보기로 확인하세요.</p>
			{error ? (
				<p role="alert" className={styles.error}>
					{error}
				</p>
			) : null}
			{!metadata && !error ? <p role="status">소스 정보 읽는 중…</p> : null}
			<fieldset disabled={busy || !metadata} className={styles.fields}>
				<div className={styles.range}>
					<label>
						시작 (초)
						<input
							aria-label="클립 시작 (초)"
							type="number"
							min={0}
							step={0.1}
							value={startMs / 1000}
							onChange={(event) => {
								setPreview(false);
								setStartMs(Math.round(event.target.valueAsNumber * 1000));
							}}
						/>
					</label>
					<label>
						끝 (초)
						<input
							aria-label="클립 끝 (초)"
							type="number"
							min={0}
							step={0.1}
							max={(metadata?.durationMs ?? 0) / 1000}
							value={endMs / 1000}
							onChange={(event) => {
								setPreview(false);
								setEndMs(Math.round(event.target.valueAsNumber * 1000));
							}}
						/>
					</label>
				</div>
				{metadata ? (
					<p className={styles.hint}>
						원본 {(metadata.durationMs / 1000).toFixed(2)}초 · 선택{" "}
						{Math.max(0, (endMs - startMs) / 1000).toFixed(2)}초
					</p>
				) : null}
				{fit && fit.audioMs > 0 ? (
					<div className={styles.audioFit}>
						<p>
							Audio {(fit.audioMs / 1000).toFixed(1)}초 · 영상 {(fit.pictureMs / 1000).toFixed(1)}초
							· 남은 {(fit.remainingMs / 1000).toFixed(1)}초
						</p>
						<button
							type="button"
							disabled={fit.remainingMs <= 0}
							onClick={() => {
								const next = fitClipEndMs(startMs, metadata?.durationMs ?? 0, fit.remainingMs);
								if (next !== null) {
									setPreview(false);
									setEndMs(next);
								}
							}}
						>
							남은 Audio 길이에 맞추기
						</button>
						<p className={styles.hint}>
							소스가 짧으면 사용할 수 있는 구간까지 맞춥니다. 나머지는 다른 클립을 추가하세요.
						</p>
					</div>
				) : (
					<p className={styles.hint}>Audio 없이도 클립을 만들 수 있습니다.</p>
				)}
				<label>
					Remotion 효과
					<select
						aria-label="Remotion 효과"
						value={selection}
						onChange={(event) => {
							setPreview(false);
							setSelection(event.target.value as ClipEffectSelection);
						}}
					>
						<option value="none">효과 없음</option>
						<option value="random">랜덤 적용</option>
						{CLIP_EFFECTS.map((item) => (
							<option key={item.id} value={item.id}>
								{item.label}
							</option>
						))}
					</select>
				</label>
				{selection === "random" ? (
					<div className={styles.random}>
						<span>선택된 효과: {effectLabel}</span>
						<button
							type="button"
							aria-label="랜덤 효과 다시 선택"
							onClick={() => {
								setPreview(false);
								setSeed(crypto.randomUUID());
							}}
						>
							<Shuffle size={14} />
							다시 선택
						</button>
					</div>
				) : null}
				<button type="button" disabled={!validRange} onClick={() => setPreview((value) => !value)}>
					{preview ? "미리보기 닫기" : "클립 미리보기"}
				</button>
			</fieldset>
			{preview && validRange && metadata ? (
				<ClipPreview
					sourceUrl={sourceUrl}
					startMs={startMs}
					endMs={endMs}
					effect={effect}
					width={metadata.width}
					height={metadata.height}
				/>
			) : null}
			<button
				type="button"
				className={styles.create}
				disabled={busy || !validRange || !projectId}
				onClick={() => void createClip()}
			>
				<WandSparkles size={15} />
				{busy ? "클립 만드는 중…" : "클립 만들고 타임라인에 추가"}
			</button>
			<p className={styles.hint}>
				원본은 유지됩니다. 효과가 적용된 새 클립은 저장·내보내기에도 같은 모습으로 사용됩니다.
			</p>
		</section>
	);
}
