import {
	ArrowRight,
	Check,
	Headphones,
	Loader2,
	Music2,
	Pause,
	Play,
	Trash2,
	Upload,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { toFileUrl } from "@/components/video-editor/projectPersistence";
import type { AxcutAsset, AxcutAudioBoardLayer, AxcutDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { currentWriteEpoch } from "@/lib/ai-edition/store/undoStack";
import { formatSeconds } from "@/lib/ai-edition/timeline/format";
import {
	addLayers,
	adoptProgrammeTracks,
	audioBoardOf,
	isAudible,
	type LayerDraft,
	type LayerKind,
	type LayerPatch,
	layerAsTrack,
	layerLabel,
	layerSpanSec,
	MAX_VOLUME,
	type MixStatus,
	mixDurationSec,
	mixStatus,
	normalizedLayer,
	removeLayer,
	updateLayer,
} from "@/lib/audio-board/board";
import { useAudioMixStore } from "@/lib/audio-board/store";
import { samePath } from "@/lib/media-board/board";
import { mutateDocument } from "@/lib/media-board/mutate";
import { resolveTimelineAudioPlayback, timelineAudioFadeAt } from "../VirtualPreview";
import { AudioLayerTimeline, type LayerSource } from "./AudioLayerTimeline";
import styles from "./AudioStage.module.css";

/**
 * Audio: music and narration files as layers on a timeline of their own. Each layer is placed,
 * trimmed, set in volume (a percentage of the file's own level) and faded; 미리듣기 plays them
 * together as they are; Media에 반영 mixes them into one file that the programme — and Media's
 * fit — then plays as its only audio.
 */
export function AudioStage({
	onContinue,
	onNewProject,
}: {
	onContinue: () => void;
	onNewProject: () => void;
}) {
	const document = useProjectStore((state) => state.document);
	const playing = useProjectStore((state) => state.playing);
	const applying = useAudioMixStore((state) => state.applying);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [live, setLive] = useState<{ id: string; patch: LayerPatch } | null>(null);
	const [importing, setImporting] = useState(false);

	// Tracks the programme already plays — from before the board, or added in Edit — become
	// layers, so the board is the whole soundtrack before anything is mixed.
	useEffect(() => {
		if (document && adoptProgrammeTracks(document) !== document)
			void mutateDocument(adoptProgrammeTracks, { history: false });
	}, [document]);

	const assets = document?.assets ?? [];
	const board = audioBoardOf(document);
	const layers = useMemo(
		() =>
			board.layers.map((layer) =>
				live?.id === layer.id
					? normalizedLayer(
							layer,
							live.patch,
							document?.assets.find((asset) => asset.id === layer.assetId)?.durationSec,
						)
					: layer,
			),
		[board.layers, live, document?.assets],
	);
	const selected = layers.find((layer) => layer.id === selectedId) ?? null;
	const duration = mixDurationSec(layers);
	const status = mixStatus(document);

	const commit = (id: string, patch: LayerPatch) => {
		setLive({ id, patch });
		void mutateDocument((current) => updateLayer(current, id, patch), { history: true }).finally(
			() => setLive((current) => (current?.patch === patch ? null : current)),
		);
	};

	const sources = (layer: AxcutAudioBoardLayer): LayerSource => {
		const asset = assets.find((entry) => entry.id === layer.assetId);
		return {
			label: layerLabel(document, layer),
			url: asset ? toFileUrl(asset.originalPath) : undefined,
			durationSec: asset?.durationSec,
		};
	};

	const importAudio = async (kind: LayerKind) => {
		const state = useProjectStore.getState();
		if (!state.projectId) return;
		const projectId = state.projectId;
		const epoch = currentWriteEpoch();
		const superseded = () =>
			useProjectStore.getState().projectId !== projectId || currentWriteEpoch() !== epoch;
		setImporting(true);
		try {
			const picker = await window.electronAPI?.openAudioFilesPicker?.();
			if (!picker || picker.canceled || superseded()) return;
			if (!picker.success)
				throw new Error(
					picker.message ||
						(picker.rejected.length > 0
							? `읽을 수 없는 파일입니다: ${picker.rejected.join(", ")}`
							: "오디오 파일을 열 수 없습니다."),
				);
			const drafts: LayerDraft[] = [];
			const unreadable = [...picker.rejected];
			for (const file of picker.files) {
				const known = useProjectStore
					.getState()
					.document?.assets.find(
						(asset) => asset.kind === "audio" && samePath(asset.originalPath, file.path),
					);
				const asset =
					known ?? (await useProjectStore.getState().addAudioAsset(file.path, file.name));
				if (superseded()) return;
				if (asset?.durationSec && asset.durationSec > 0)
					drafts.push({
						assetId: asset.id,
						kind,
						label: asset.label,
						durationSec: asset.durationSec,
					});
				else unreadable.push(file.name);
			}
			let added: string[] = [];
			if (drafts.length > 0)
				await mutateDocument(
					(current) => {
						const result = addLayers(current, drafts);
						added = result.ids;
						return result.document;
					},
					{ history: true },
				);
			if (added.length > 0) {
				setSelectedId(added[0]);
				toast.success(
					`${kind === "music" ? "음악" : "나레이션"} ${added.length}개를 레이어로 넣었습니다.`,
					unreadable.length > 0
						? { description: `길이를 읽지 못한 파일: ${unreadable.join(", ")}` }
						: undefined,
				);
			} else if (unreadable.length > 0)
				throw new Error(`길이를 읽을 수 없는 파일입니다: ${unreadable.join(", ")}`);
		} catch (error) {
			toast.error("오디오를 가져오지 못했습니다.", {
				description: error instanceof Error ? error.message : String(error),
			});
		} finally {
			setImporting(false);
		}
	};

	const togglePreview = () => {
		const state = useProjectStore.getState();
		if (duration <= 0) return;
		if (!state.playing && state.currentTimeSec >= duration) state.setCurrentTime(0);
		state.setPlaying(!state.playing);
	};

	return (
		<div className={styles.stage}>
			<LayerPlayback layers={layers} assets={assets} duration={duration} />
			<div className={styles.page}>
				<div className={styles.inner}>
					<header className={styles.header}>
						<div>
							<h1>Audio</h1>
							<p className={styles.hint}>
								음악과 나레이션을 레이어로 놓고 위치·길이·볼륨을 맞춘 뒤 미리 들어 보세요.{" "}
								<strong>Media에 반영</strong>하면 레이어가 하나의 오디오로 섞여, Media가 영상과
								사진을 그 길이에 맞춥니다.
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

					<div className={styles.toolbar}>
						<button
							type="button"
							className={styles.button}
							disabled={!document || importing}
							onClick={() => void importAudio("music")}
						>
							<Music2 size={16} />
							음악 가져오기
						</button>
						<button
							type="button"
							className={styles.button}
							disabled={!document || importing}
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
						{layers.length > 0 ? (
							<>
								<span className={styles.divider} aria-hidden />
								<button
									type="button"
									className={styles.button}
									disabled={duration <= 0}
									onClick={togglePreview}
								>
									{playing ? <Pause size={15} /> : <Play size={15} />}
									{playing ? "일시 정지" : "미리듣기"}
								</button>
								<PreviewClock duration={duration} />
								<span className={styles.spacer} />
								<MixState status={status} applying={applying} document={document} />
								<button
									type="button"
									className={`${styles.button} ${styles.primary}`}
									disabled={applying || status === "empty" || status === "applied"}
									onClick={() => void useAudioMixStore.getState().apply()}
								>
									{applying ? <Loader2 size={15} className={styles.spin} /> : <Upload size={15} />}
									Media에 반영
								</button>
							</>
						) : null}
					</div>

					{layers.length === 0 ? (
						<div className={styles.empty}>
							<Music2 size={36} />
							<strong>음악과 나레이션으로 시작하세요</strong>
							<p className={styles.hint}>
								MP3, WAV 등 여러 파일을 한 번에 가져올 수 있습니다. 파일마다 레이어가 되어 아래
								타임라인에 놓입니다.
								<br />
								오디오 없이 바로 V.Clip이나 Media에서 시작해도 됩니다.
							</p>
						</div>
					) : selected ? (
						<LayerOptions
							key={selected.id}
							layer={selected}
							document={document}
							onLive={(patch) => setLive({ id: selected.id, patch })}
							onCommit={(patch) => commit(selected.id, patch)}
							onRemove={() => {
								setSelectedId(null);
								void mutateDocument((current) => removeLayer(current, selected.id), {
									history: true,
								});
							}}
						/>
					) : (
						<p className={styles.note}>
							아래 타임라인에서 레이어를 누르면 볼륨·페이드·구간을 조절할 수 있습니다.
						</p>
					)}
				</div>
			</div>
			{layers.length > 0 ? (
				<div className={styles.dock} style={{ height: 96 + 46 * Math.max(2, layers.length) }}>
					<AudioLayerTimeline
						layers={layers}
						sources={sources}
						selectedId={selected?.id ?? null}
						onSelect={setSelectedId}
						onLive={(id, patch) => setLive({ id, patch })}
						onCommit={commit}
					/>
				</div>
			) : null}
		</div>
	);
}

function PreviewClock({ duration }: { duration: number }) {
	const time = useProjectStore((state) => state.currentTimeSec);
	return (
		<label className={styles.clock}>
			<input
				type="range"
				aria-label="미리듣기 위치"
				min={0}
				max={Math.max(duration, 0.01)}
				step={0.01}
				value={Math.min(time, duration)}
				onChange={(event) => useProjectStore.getState().setCurrentTime(Number(event.target.value))}
			/>
			<span>
				{formatSeconds(Math.min(time, duration))} / {formatSeconds(duration)}
			</span>
		</label>
	);
}

function MixState({
	status,
	applying,
	document,
}: {
	status: MixStatus;
	applying: boolean;
	document: AxcutDocument | null;
}) {
	if (applying)
		return (
			<span className={styles.state} data-tone="busy">
				오디오를 하나로 섞는 중…
			</span>
		);
	if (status === "applied") {
		const mix = document?.audioTracks.find(
			(track) => track.assetId === audioBoardOf(document).mix?.assetId,
		);
		return (
			<span className={styles.state} data-tone="ok">
				<Check size={13} />
				Media에 반영됨{mix ? ` · ${formatSeconds(mix.endMs / 1000)}` : ""}
			</span>
		);
	}
	return (
		<span className={styles.state} data-tone="off">
			{status === "changed"
				? "바뀐 내용이 있습니다 · 다시 반영하세요"
				: status === "empty"
					? "소리가 나는 레이어가 없습니다"
					: "아직 Media에 반영하지 않았습니다"}
		</span>
	);
}

function LayerOptions({
	layer,
	document,
	onLive,
	onCommit,
	onRemove,
}: {
	layer: AxcutAudioBoardLayer;
	document: AxcutDocument | null;
	onLive: (patch: LayerPatch) => void;
	onCommit: (patch: LayerPatch) => void;
	onRemove: () => void;
}) {
	const asset = document?.assets.find((entry) => entry.id === layer.assetId);
	const sourceSec = asset?.durationSec;
	const span = layerSpanSec(layer);
	return (
		<section className={styles.panel} aria-label="레이어 설정">
			<div className={styles.panelHead}>
				{layer.kind === "music" ? <Music2 size={18} /> : <Headphones size={18} />}
				<h2 title={layerLabel(document, layer)}>{layerLabel(document, layer)}</h2>
				<span className={styles.hint}>
					{asset ? `원본 ${formatSeconds(sourceSec ?? 0)} · ` : "파일이 프로젝트에 없습니다 · "}
					쓰는 구간 {formatSeconds(span)}
				</span>
				<div className={styles.kinds} role="group" aria-label="종류">
					{(
						[
							["music", "음악"],
							["voiceover", "나레이션"],
						] as const
					).map(([kind, label]) => (
						<button
							key={kind}
							type="button"
							aria-pressed={layer.kind === kind}
							onClick={() => onCommit({ kind })}
						>
							{label}
						</button>
					))}
				</div>
			</div>
			<VolumeControl volume={layer.volume} onLive={onLive} onCommit={onCommit} />
			<div className={styles.fields}>
				<NumberField
					label="타임라인 시작 (초)"
					value={layer.startSec}
					onCommit={(startSec) => onCommit({ startSec })}
				/>
				<NumberField
					label="원본 시작 (초)"
					value={layer.inSec}
					max={sourceSec}
					onCommit={(inSec) => onCommit({ inSec })}
				/>
				<NumberField
					label="원본 끝 (초)"
					value={layer.outSec}
					max={sourceSec}
					onCommit={(outSec) => onCommit({ outSec })}
				/>
				<NumberField
					label="페이드 인 (초)"
					value={layer.fadeInSec}
					max={span}
					onCommit={(fadeInSec) => onCommit({ fadeInSec })}
				/>
				<NumberField
					label="페이드 아웃 (초)"
					value={layer.fadeOutSec}
					max={span}
					onCommit={(fadeOutSec) => onCommit({ fadeOutSec })}
				/>
			</div>
			<div className={styles.row}>
				<label className={styles.inline}>
					<input
						type="checkbox"
						checked={layer.muted}
						onChange={(event) => onCommit({ muted: event.target.checked })}
					/>
					음소거 (믹스에서 뺍니다)
				</label>
				<button type="button" className={styles.button} onClick={onRemove}>
					<Trash2 size={15} />
					레이어 삭제
				</button>
			</div>
		</section>
	);
}

/** Volume in percent of the file's own level; the slider plays live and writes on release. */
function VolumeControl({
	volume,
	onLive,
	onCommit,
}: {
	volume: number;
	onLive: (patch: LayerPatch) => void;
	onCommit: (patch: LayerPatch) => void;
}) {
	const dragged = useRef<number | null>(null);
	const release = () => {
		const value = dragged.current;
		dragged.current = null;
		if (value !== null) onCommit({ volume: value });
	};
	return (
		<div className={styles.volume}>
			<span className={styles.volumeLabel}>볼륨</span>
			<input
				type="range"
				aria-label="볼륨"
				min={0}
				max={MAX_VOLUME}
				step={1}
				value={volume}
				onChange={(event) => {
					dragged.current = Number(event.target.value);
					onLive({ volume: dragged.current });
				}}
				onPointerUp={release}
				onKeyUp={release}
				onBlur={release}
			/>
			<NumberField
				label="볼륨 (%)"
				value={volume}
				step={1}
				max={MAX_VOLUME}
				onCommit={(value) => onCommit({ volume: value })}
			/>
			<div className={styles.presets}>
				{[50, 100, 150].map((preset) => (
					<button
						key={preset}
						type="button"
						aria-pressed={volume === preset}
						onClick={() => onCommit({ volume: preset })}
					>
						{preset}%
					</button>
				))}
			</div>
		</div>
	);
}

/** A number that is written when the field is left or Enter is pressed, not on every keystroke. */
function NumberField({
	label,
	value,
	max,
	step = 0.1,
	onCommit,
}: {
	label: string;
	value: number;
	max?: number;
	step?: number;
	onCommit: (value: number) => void;
}) {
	const shown = String(Math.round(value * 1000) / 1000);
	const [draft, setDraft] = useState(shown);
	useEffect(() => setDraft(shown), [shown]);
	const commit = () => {
		const parsed = Number(draft);
		if (draft.trim() !== "" && Number.isFinite(parsed) && Math.abs(parsed - value) > 0.0005)
			onCommit(parsed);
		else setDraft(shown);
	};
	return (
		<label className={styles.field}>
			{label}
			<input
				type="number"
				aria-label={label}
				min={0}
				max={max}
				step={step}
				value={draft}
				onChange={(event) => setDraft(event.target.value)}
				onBlur={commit}
				onKeyDown={(event) => {
					if (event.key === "Enter") commit();
				}}
			/>
		</label>
	);
}

/**
 * Plays the layers on the project clock, as the mix will sound: each file from its in-point at
 * its start, at its volume and through its fades. The page's own clock drives it — Audio has no
 * picture to follow.
 */
function LayerPlayback({
	layers,
	assets,
	duration,
}: {
	layers: AxcutAudioBoardLayer[];
	assets: AxcutAsset[];
	duration: number;
}) {
	const elements = useRef(new Map<string, HTMLAudioElement>());
	const latest = useRef({ layers, assets, duration });
	latest.current = { layers, assets, duration };
	useEffect(() => {
		let frame = 0;
		let last = performance.now();
		let context: AudioContext | null = null;
		const gains = new Map<HTMLAudioElement, GainNode>();
		const synchronize = () => {
			const state = useProjectStore.getState();
			for (const layer of latest.current.layers) {
				const element = elements.current.get(layer.id);
				if (!element) continue;
				const asset = latest.current.assets.find((entry) => entry.id === layer.assetId);
				const track = layerAsTrack(layer, asset?.durationSec);
				const span = layerSpanSec(layer);
				const target = resolveTimelineAudioPlayback(
					state.currentTimeSec,
					layer.startSec,
					track,
					span,
				);
				const shouldPlay = state.playing && target.shouldPlay && isAudible(layer);
				if (
					element.readyState >= 1 &&
					Math.abs(element.currentTime - target.targetTimeSec) > (shouldPlay ? 0.25 : 0.025)
				)
					element.currentTime = target.targetTimeSec;
				const gainValue =
					(layer.volume / 100) *
					timelineAudioFadeAt(track, state.currentTimeSec - layer.startSec, span);
				// Past 100% needs a gain node: an element's own volume stops at 1.
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
			{layers.map((layer) => {
				const asset = assets.find((entry) => entry.id === layer.assetId);
				return asset ? (
					<audio
						key={layer.id}
						ref={(element) => {
							if (element) elements.current.set(layer.id, element);
							else elements.current.delete(layer.id);
						}}
						src={toFileUrl(asset.originalPath)}
						preload="auto"
						aria-label={`${layerLabel(null, layer)} 미리듣기`}
					/>
				) : null;
			})}
		</div>
	);
}
