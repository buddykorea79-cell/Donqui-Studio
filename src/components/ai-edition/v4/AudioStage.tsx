import { ArrowRight, Headphones, Music2, Pause, Play, Trash2, Volume2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { toFileUrl } from "@/components/video-editor/projectPersistence";
import {
	type AudioTrackEdit,
	audioProgrammeDuration,
	editAudioFirstTrack,
} from "@/lib/ai-edition/document/audioFirst";
import {
	collapseTracksToPills,
	placeAudioTrackInDocument,
	removeAudioTrack,
} from "@/lib/ai-edition/document/audioTracks";
import { createId } from "@/lib/ai-edition/document/ids";
import { type AxcutAsset, type AxcutAudioTrack, createAudioTrack } from "@/lib/ai-edition/schema";
import { enqueueDocumentWrite } from "@/lib/ai-edition/store/documentWriteQueue";
import { audioGainScalar } from "@/lib/ai-edition/store/editorSettings";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { currentWriteEpoch } from "@/lib/ai-edition/store/undoStack";
import { formatSeconds } from "@/lib/ai-edition/timeline/format";
import { resolveTimelineAudioPlayback, timelineAudioFadeAt } from "../VirtualPreview";
import styles from "./AudioStage.module.css";

export function AudioStage({
	onContinue,
	onNewProject,
}: {
	onContinue: () => void;
	onNewProject: () => void;
}) {
	const document = useProjectStore((state) => state.document);
	const selectedId = useProjectStore((state) => state.selectedAudioTrackId);
	const playing = useProjectStore((state) => state.playing);
	const [busy, setBusy] = useState(false);
	const tracks = useMemo(
		() => collapseTracksToPills(document?.audioTracks ?? []),
		[document?.audioTracks],
	);
	const selected = tracks.find((track) => track.id === selectedId) ?? tracks[0];
	const duration = audioProgrammeDuration(document);
	const selectedAsset = document?.assets.find((asset) => asset.id === selected?.assetId);

	const importAudio = async (kind: "music" | "voiceover") => {
		const state = useProjectStore.getState();
		if (!state.projectId) return;
		const projectId = state.projectId;
		const epoch = currentWriteEpoch();
		const superseded = () =>
			useProjectStore.getState().projectId !== projectId || currentWriteEpoch() !== epoch;
		setBusy(true);
		try {
			const picker = await window.electronAPI?.openAudioFilePicker?.();
			if (picker?.canceled || superseded()) return;
			if (!picker?.success || !picker.path)
				throw new Error(picker?.message || "오디오 파일을 열 수 없습니다.");
			const asset = await state.addAudioAsset(picker.path, picker.name);
			if (!asset || superseded()) return;
			const durationSec = asset.durationSec;
			if (!(durationSec && durationSec > 0)) {
				throw new Error("오디오 길이를 읽을 수 없습니다. 재생 가능한 파일을 선택해 주세요.");
			}
			// addAudioAsset owns its own queued import. Only enqueue placement after it
			// resolves, so this task never waits on another task behind itself.
			await enqueueDocumentWrite(async () => {
				const current = useProjectStore.getState();
				if (!current.document || superseded()) return;
				if (!current.document.assets.some((item) => item.id === asset.id)) return;
				const track: AxcutAudioTrack = {
					...createAudioTrack({
						assetId: asset.id,
						durationSec,
						kind,
						label: asset.label,
					}),
					timelineLocked: true,
				};
				const next = placeAudioTrackInDocument(
					current.document,
					track,
					() => createId("audio"),
					"create",
				);
				if ((await current.saveDocument(next, { history: true })) && !superseded()) {
					current.setSelectedAudioTrackId(track.id);
					toast.success(kind === "music" ? "음악을 추가했습니다." : "나레이션을 추가했습니다.");
				}
			});
		} catch (error) {
			toast.error("오디오를 추가하지 못했습니다.", {
				description: error instanceof Error ? error.message : String(error),
			});
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className={styles.stage}>
			<AudioTimelinePlayback tracks={tracks} assets={document?.assets ?? []} duration={duration} />
			<div className={styles.inner}>
				<header className={styles.header}>
					<div>
						<h1>Audio</h1>
						<p className={styles.hint}>
							음악이나 나레이션을 먼저 배치하고, V.Clip에서 영상을 구간으로 나눠 길이에 맞춰 보세요.
							<br />
							오디오 없이 바로 시작해도 됩니다.
						</p>
					</div>
					<button
						type="button"
						className={`${styles.button} ${styles.primary}`}
						onClick={onContinue}
					>
						V.Clip으로 이동 <ArrowRight size={15} />
					</button>
				</header>
				<div className={styles.actions}>
					<button
						type="button"
						className={styles.button}
						disabled={!document || busy}
						onClick={() => void importAudio("music")}
					>
						<Music2 size={16} />
						음악 가져오기
					</button>
					<button
						type="button"
						className={styles.button}
						disabled={!document || busy}
						onClick={() => void importAudio("voiceover")}
					>
						<Headphones size={16} />
						나레이션 가져오기
					</button>
					{!document ? (
						<button type="button" className={styles.button} onClick={onNewProject}>
							새 프로젝트
						</button>
					) : null}
					{tracks.length > 0 ? (
						<>
							<button
								type="button"
								className={styles.button}
								onClick={() => {
									const state = useProjectStore.getState();
									if (!state.playing && state.currentTimeSec >= duration) state.setCurrentTime(0);
									state.setPlaying(!state.playing);
								}}
							>
								{playing ? <Pause size={15} /> : <Play size={15} />}
								{playing ? "일시 정지" : "오디오 전체 미리보기"}
							</button>
							<span className={styles.hint}>오디오 끝 {formatSeconds(duration)}</span>
						</>
					) : null}
				</div>
				{tracks.length > 0 ? <AudioSeekBar duration={duration} /> : null}
				{tracks.length === 0 ? (
					<div className={styles.empty}>
						<Music2 size={36} />
						<strong>음악과 목소리로 시작하세요</strong>
						<p className={styles.hint}>
							MP3, WAV 등의 파일을 가져오면 길이와 시작 위치를 조절할 수 있습니다.
							<br />
							오디오가 준비되지 않았다면 Media 탭에서 영상·이미지부터 추가하세요.
						</p>
					</div>
				) : (
					<div className={styles.columns}>
						<div className={styles.list}>
							{tracks.map((track) => (
								<button
									type="button"
									key={track.id}
									className={styles.track}
									aria-pressed={selected?.id === track.id}
									onClick={() => useProjectStore.getState().setSelectedAudioTrackId(track.id)}
								>
									{track.kind === "music" ? <Music2 size={22} /> : <Headphones size={22} />}
									<span className={styles.trackText}>
										<strong>
											{track.label ||
												document?.assets.find((asset) => asset.id === track.assetId)?.label ||
												"Audio"}
										</strong>
										<span>
											{track.kind === "music" ? "음악" : "나레이션"} ·{" "}
											{formatSeconds(track.startMs / 1000)} – {formatSeconds(track.endMs / 1000)}
										</span>
									</span>
								</button>
							))}
						</div>
						{selected && selectedAsset ? (
							<AudioTrackEditor
								key={`${selected.id}:${selected.startMs}:${selected.endMs}:${selected.offsetMs}:${selected.gainDb}`}
								track={selected}
								asset={selectedAsset}
							/>
						) : null}
					</div>
				)}
			</div>
		</div>
	);
}

function AudioSeekBar({ duration }: { duration: number }) {
	const time = useProjectStore((state) => state.currentTimeSec);
	return (
		<label className={styles.seekbar}>
			<span>
				오디오 위치 {formatSeconds(Math.min(time, duration))} / {formatSeconds(duration)}
			</span>
			<input
				type="range"
				aria-label="오디오 재생 위치"
				min={0}
				max={duration}
				step={0.01}
				value={Math.min(time, duration)}
				onChange={(event) => useProjectStore.getState().setCurrentTime(Number(event.target.value))}
			/>
		</label>
	);
}

function AudioTrackEditor({ track, asset }: { track: AxcutAudioTrack; asset: AxcutAsset }) {
	const timelinePlaying = useProjectStore((state) => state.playing);
	const [edit, setEdit] = useState<AudioTrackEdit>({
		startSec: track.startMs / 1000,
		inSec: track.offsetMs / 1000,
		outSec: Math.min(
			asset.durationSec ?? track.durationSec,
			(track.offsetMs + track.endMs - track.startMs) / 1000,
		),
		gainDb: track.gainDb,
	});
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const sourceRef = useRef<HTMLAudioElement>(null);
	const graph = useRef<{ context: AudioContext; gain: GainNode } | null>(null);
	useEffect(() => {
		if (timelinePlaying && sourceRef.current && !sourceRef.current.paused)
			sourceRef.current.pause();
	}, [timelinePlaying]);
	useEffect(
		() => () => {
			void graph.current?.context.close();
		},
		[],
	);
	useEffect(() => {
		if (graph.current) graph.current.gain.gain.value = audioGainScalar(edit.gainDb);
		else if (sourceRef.current)
			sourceRef.current.volume = Math.min(1, audioGainScalar(edit.gainDb));
	}, [edit.gainDb]);
	const save = async () => {
		const projectId = useProjectStore.getState().projectId;
		const epoch = currentWriteEpoch();
		setBusy(true);
		setError("");
		try {
			await enqueueDocumentWrite(async () => {
				const state = useProjectStore.getState();
				if (!state.document || state.projectId !== projectId || currentWriteEpoch() !== epoch)
					return;
				const next = editAudioFirstTrack(state.document, track.id, edit);
				if (await state.saveDocument(next, { history: true }))
					toast.success("오디오 설정을 적용했습니다.");
			});
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure));
		} finally {
			setBusy(false);
		}
	};
	return (
		<section className={styles.panel} aria-label="선택한 오디오 편집">
			<h2>{track.label || asset.label}</h2>
			<audio
				ref={sourceRef}
				controls
				preload="metadata"
				src={toFileUrl(asset.originalPath)}
				aria-label="선택한 오디오 미리보기"
				onLoadedMetadata={(event) => {
					event.currentTarget.currentTime = edit.inSec;
				}}
				onPlay={(event) => {
					useProjectStore.getState().setPlaying(false);
					const element = event.currentTarget;
					if (element.currentTime < edit.inSec || element.currentTime >= edit.outSec)
						element.currentTime = edit.inSec;
					if (!graph.current && typeof AudioContext !== "undefined") {
						const context = new AudioContext();
						const gain = context.createGain();
						context.createMediaElementSource(element).connect(gain).connect(context.destination);
						graph.current = { context, gain };
						element.volume = 1;
					}
					if (graph.current) {
						graph.current.gain.gain.value = audioGainScalar(edit.gainDb);
						void graph.current.context.resume();
					}
				}}
				onTimeUpdate={(event) => {
					if (event.currentTarget.currentTime < edit.inSec)
						event.currentTarget.currentTime = edit.inSec;
					if (event.currentTarget.currentTime >= edit.outSec) event.currentTarget.pause();
				}}
			/>
			<p className={styles.hint}>
				원본 {formatSeconds(asset.durationSec ?? track.durationSec)} · 선택한 구간{" "}
				{formatSeconds(Math.max(0, edit.outSec - edit.inSec))}
				<br />
				{track.timelineLocked
					? "영상 클립을 편집해도 이 오디오의 위치와 길이는 유지됩니다."
					: "이 오디오는 연결된 영상 클립을 따라 이동합니다."}
			</p>
			<div className={styles.fields}>
				{(
					[
						{ key: "startSec", label: "타임라인 시작 (초)", min: 0 },
						{ key: "inSec", label: "원본 시작 (초)", min: 0 },
						{ key: "outSec", label: "원본 종료 (초)", min: 0 },
						{ key: "gainDb", label: "볼륨 (dB)", min: -60 },
					] as const
				).map((field) => (
					<label key={field.key}>
						{field.label}
						<input
							type="number"
							aria-label={field.label}
							min={field.min}
							max={
								field.key === "gainDb"
									? 12
									: field.key === "startSec"
										? undefined
										: asset.durationSec
							}
							step={field.key === "gainDb" ? 1 : 0.1}
							value={edit[field.key]}
							onChange={(event) => setEdit({ ...edit, [field.key]: Number(event.target.value) })}
						/>
					</label>
				))}
			</div>
			{error ? (
				<p role="alert" className={styles.error}>
					{error}
				</p>
			) : null}
			<div className={styles.actions}>
				<button
					type="button"
					className={`${styles.button} ${styles.primary}`}
					disabled={busy}
					onClick={() => void save()}
				>
					<Volume2 size={15} />
					설정 적용
				</button>
				<button
					type="button"
					className={styles.button}
					disabled={busy}
					onClick={() => {
						const projectId = useProjectStore.getState().projectId;
						const epoch = currentWriteEpoch();
						void enqueueDocumentWrite(async () => {
							const state = useProjectStore.getState();
							if (!state.document || state.projectId !== projectId || currentWriteEpoch() !== epoch)
								return;
							await state.saveDocument(removeAudioTrack(state.document, track.id), {
								history: true,
							});
						});
					}}
				>
					<Trash2 size={15} />
					삭제
				</button>
			</div>
		</section>
	);
}

/** Audio owns the clock on this surface, including before the first visual clip. */
function AudioTimelinePlayback({
	tracks,
	assets,
	duration,
}: {
	tracks: AxcutAudioTrack[];
	assets: AxcutAsset[];
	duration: number;
}) {
	const elements = useRef(new Map<string, HTMLAudioElement>());
	const latest = useRef({ tracks, duration });
	latest.current = { tracks, duration };
	useEffect(() => {
		let frame = 0;
		let last = performance.now();
		let context: AudioContext | null = null;
		const gains = new Map<HTMLAudioElement, GainNode>();
		const synchronize = () => {
			const state = useProjectStore.getState();
			for (const track of latest.current.tracks) {
				const element = elements.current.get(track.id);
				if (!element) continue;
				const span = (track.endMs - track.startMs) / 1000;
				const target = resolveTimelineAudioPlayback(
					state.currentTimeSec,
					track.startMs / 1000,
					track,
					span,
				);
				const shouldPlay = state.playing && target.shouldPlay && !track.muted;
				if (
					element.readyState >= 1 &&
					Math.abs(element.currentTime - target.targetTimeSec) > (shouldPlay ? 0.25 : 0.025)
				) {
					element.currentTime = target.targetTimeSec;
				}
				const gainValue =
					audioGainScalar(track.gainDb) *
					timelineAudioFadeAt(track, state.currentTimeSec - track.startMs / 1000, span);
				if (shouldPlay && typeof AudioContext !== "undefined" && !gains.has(element)) {
					context ??= new AudioContext();
					const gain = context.createGain();
					context.createMediaElementSource(element).connect(gain).connect(context.destination);
					gains.set(element, gain);
				}
				const gain = gains.get(element);
				if (gain) {
					gain.gain.value = gainValue;
					element.volume = 1;
				} else element.volume = Math.min(1, gainValue);
				if (shouldPlay && element.paused) {
					if (context?.state === "suspended") void context.resume();
					void element.play()?.catch(() => useProjectStore.getState().setPlaying(false));
				} else if (!shouldPlay && !element.paused) element.pause();
			}
		};
		const tick = (now: number) => {
			const elapsed = Math.min(0.1, (now - last) / 1000);
			last = now;
			const state = useProjectStore.getState();
			if (state.playing) {
				const next = Math.min(latest.current.duration, state.currentTimeSec + elapsed);
				state.setCurrentTime(next);
				if (next >= latest.current.duration) state.setPlaying(false);
			}
			synchronize();
			frame = requestAnimationFrame(tick);
		};
		frame = requestAnimationFrame(tick);
		return () => {
			cancelAnimationFrame(frame);
			useProjectStore.getState().setPlaying(false);
			void context?.close();
		};
	}, []);
	return (
		<div hidden>
			{tracks.map((track) => {
				const asset = assets.find((item) => item.id === track.assetId);
				return asset ? (
					<audio
						key={track.id}
						ref={(element) => {
							if (element) elements.current.set(track.id, element);
							else elements.current.delete(track.id);
						}}
						src={toFileUrl(asset.originalPath)}
						preload="metadata"
						aria-label="오디오 타임라인 트랙"
					/>
				) : null;
			})}
		</div>
	);
}
