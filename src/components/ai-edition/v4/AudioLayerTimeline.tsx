import { Headphones, Music2, Volume2, VolumeX, ZoomIn, ZoomOut } from "lucide-react";
import {
	type PointerEvent as ReactPointerEvent,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useAudioPeaks } from "@/hooks/useAudioPeaks";
import type { AxcutAudioBoardLayer } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { formatSeconds } from "@/lib/ai-edition/timeline/format";
import {
	boardEndSec,
	type LayerPatch,
	layerEndSec,
	layerSpanSec,
	MIN_LAYER_SEC,
} from "@/lib/audio-board/board";
import styles from "./AudioLayerTimeline.module.css";

/**
 * The Audio tab's timeline: one row per layer. Drag a layer to move it, drag its edges to trim
 * the file it plays, click the ruler to move the playhead. Edges snap to the start, the playhead
 * and the other layers' edges, so narrations line up back to back. A drag is shown live through
 * `onLive` and written once, on release, through `onCommit`.
 */

export interface LayerSource {
	label: string;
	url?: string;
	durationSec?: number;
}

type DragMode = "move" | "in" | "out";

interface Drag {
	id: string;
	mode: DragMode;
	startX: number;
	secPerPx: number;
	layer: AxcutAudioBoardLayer;
	patch: LayerPatch | null;
}

const ZOOMS = [1, 2, 4, 8] as const;
const SNAP_PX = 8;
const TICK_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
const round3 = (value: number) => Math.round(value * 1000) / 1000;

/** The target nearest `value` within `threshold`, or null. */
function nearestSnap(value: number, targets: number[], threshold: number): number | null {
	let best: number | null = null;
	for (const target of targets) {
		const gap = Math.abs(target - value);
		if (gap <= threshold && (best === null || gap < Math.abs(best - value))) best = target;
	}
	return best;
}

/**
 * The layer as `mode` drags it by `deltaSec`: moved whole, or trimmed at one edge — the in-point
 * moving the start with it, so what plays stays where it was — kept inside its file and at least
 * MIN_LAYER_SEC long. The dragged edge snaps to `targets` within `snapSec`; a moved layer snaps
 * by whichever of its edges is nearer one.
 */
export function draggedLayer(
	layer: AxcutAudioBoardLayer,
	mode: DragMode,
	deltaSec: number,
	sourceDurationSec: number | undefined,
	targets: number[] = [],
	snapSec = 0,
): LayerPatch {
	if (mode === "move") {
		const span = layerSpanSec(layer);
		const raw = Math.max(0, layer.startSec + deltaSec);
		const head = nearestSnap(raw, targets, snapSec);
		const tail = nearestSnap(raw + span, targets, snapSec);
		let startSec = raw;
		if (head !== null && (tail === null || Math.abs(head - raw) <= Math.abs(tail - raw - span)))
			startSec = head;
		else if (tail !== null) startSec = tail - span;
		return { startSec: round3(Math.max(0, startSec)) };
	}
	if (mode === "in") {
		const low = -Math.min(layer.inSec, layer.startSec);
		const high = layer.outSec - MIN_LAYER_SEC - layer.inSec;
		const bounded = (delta: number) => Math.min(high, Math.max(low, delta));
		const raw = layer.startSec + bounded(deltaSec);
		const delta = bounded((nearestSnap(raw, targets, snapSec) ?? raw) - layer.startSec);
		return { startSec: round3(layer.startSec + delta), inSec: round3(layer.inSec + delta) };
	}
	const limit =
		sourceDurationSec && sourceDurationSec > 0 ? sourceDurationSec : Number.POSITIVE_INFINITY;
	const rawEnd = layerEndSec(layer) + deltaSec;
	const endSec = nearestSnap(rawEnd, targets, snapSec) ?? rawEnd;
	const outSec = Math.min(
		limit,
		Math.max(layer.inSec + MIN_LAYER_SEC, layer.inSec + endSec - layer.startSec),
	);
	return { outSec: round3(outSec) };
}

export function AudioLayerTimeline({
	layers,
	sources,
	selectedId,
	onSelect,
	onLive,
	onCommit,
}: {
	layers: AxcutAudioBoardLayer[];
	sources: (layer: AxcutAudioBoardLayer) => LayerSource;
	selectedId: string | null;
	onSelect: (id: string | null) => void;
	onLive: (id: string, patch: LayerPatch) => void;
	onCommit: (id: string, patch: LayerPatch) => void;
}) {
	const [zoom, setZoom] = useState<(typeof ZOOMS)[number]>(1);
	const [widthPx, setWidthPx] = useState(0);
	const scroller = useRef<HTMLDivElement>(null);
	const lanes = useRef<HTMLDivElement>(null);
	const drag = useRef<Drag | null>(null);
	const [frozenViewSec, setFrozenViewSec] = useState<number | null>(null);

	// Some room past the last layer to drag into; the view holds still while a drag is on.
	const liveViewSec = Math.max(10, Math.ceil(boardEndSec(layers) * 1.15 + 1));
	const viewSec = frozenViewSec ?? liveViewSec;

	useLayoutEffect(() => {
		const element = scroller.current;
		if (!element) return;
		const measure = () => setWidthPx(element.clientWidth);
		measure();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	const pxPerSec = (widthPx * zoom) / viewSec;
	const tickStep = TICK_STEPS.find((step) => step * pxPerSec >= 64) ?? TICK_STEPS.at(-1) ?? 60;
	const ticks = useMemo(() => {
		const list: number[] = [];
		for (let sec = 0; sec <= viewSec + 1e-9; sec += tickStep) list.push(round3(sec));
		return list;
	}, [viewSec, tickStep]);
	const pct = (sec: number) => `${(sec / viewSec) * 100}%`;

	const secAt = (clientX: number) => {
		const rect = lanes.current?.getBoundingClientRect();
		if (!rect || rect.width <= 0) return 0;
		return Math.max(0, ((clientX - rect.left) / rect.width) * viewSec);
	};

	const seek = (event: ReactPointerEvent<HTMLElement>) => {
		const state = useProjectStore.getState();
		state.setCurrentTime(Math.min(secAt(event.clientX), Math.max(0, boardEndSec(layers))));
	};

	const startDrag = (
		event: ReactPointerEvent<HTMLElement>,
		layer: AxcutAudioBoardLayer,
		mode: DragMode,
	) => {
		if (event.button !== 0) return;
		event.stopPropagation();
		const rect = lanes.current?.getBoundingClientRect();
		const width = rect && rect.width > 0 ? rect.width : widthPx * zoom;
		drag.current = {
			id: layer.id,
			mode,
			startX: event.clientX,
			secPerPx: width > 0 ? viewSec / width : 0,
			layer,
			patch: null,
		};
		setFrozenViewSec(viewSec);
		event.currentTarget.setPointerCapture?.(event.pointerId);
	};

	const moveDrag = (event: ReactPointerEvent<HTMLElement>) => {
		const current = drag.current;
		if (!current || current.secPerPx <= 0) return;
		const dx = event.clientX - current.startX;
		if (current.patch === null && Math.abs(dx) < 3) return;
		const targets = [
			0,
			useProjectStore.getState().currentTimeSec,
			...layers
				.filter((layer) => layer.id !== current.id)
				.flatMap((layer) => [layer.startSec, layerEndSec(layer)]),
		];
		current.patch = draggedLayer(
			current.layer,
			current.mode,
			dx * current.secPerPx,
			sources(current.layer).durationSec,
			targets,
			SNAP_PX * current.secPerPx,
		);
		onLive(current.id, current.patch);
	};

	const endDrag = () => {
		const current = drag.current;
		drag.current = null;
		setFrozenViewSec(null);
		if (!current) return;
		if (current.patch) onCommit(current.id, current.patch);
	};

	const nudge = (layer: AxcutAudioBoardLayer, key: string, shift: boolean) => {
		const step = (shift ? 1 : 0.1) * (key === "ArrowLeft" ? -1 : 1);
		onSelect(layer.id);
		onCommit(layer.id, { startSec: round3(Math.max(0, layer.startSec + step)) });
	};

	return (
		<section className={styles.timeline} aria-label="오디오 레이어 타임라인">
			<div className={styles.toolbar}>
				<span className={styles.title}>레이어 {layers.length}개</span>
				<span className={styles.hint}>
					끌어서 옮기고, 양 끝을 끌어 자르세요. 눈금을 누르면 그 위치부터 들립니다.
				</span>
				<div className={styles.zoom}>
					<button
						type="button"
						aria-label="축소"
						disabled={zoom === ZOOMS[0]}
						onClick={() => setZoom(ZOOMS[Math.max(0, ZOOMS.indexOf(zoom) - 1)])}
					>
						<ZoomOut size={14} />
					</button>
					<span>×{zoom}</span>
					<button
						type="button"
						aria-label="확대"
						disabled={zoom === ZOOMS[ZOOMS.length - 1]}
						onClick={() => setZoom(ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(zoom) + 1)])}
					>
						<ZoomIn size={14} />
					</button>
				</div>
			</div>
			<div className={styles.body}>
				<div className={styles.heads}>
					<div className={styles.rulerSpacer} />
					{layers.map((layer) => {
						const { label } = sources(layer);
						return (
							<div key={layer.id} className={styles.head} data-selected={layer.id === selectedId}>
								{layer.kind === "music" ? <Music2 size={14} /> : <Headphones size={14} />}
								<button
									type="button"
									className={styles.headLabel}
									title={label}
									onClick={() => onSelect(layer.id)}
								>
									{label}
								</button>
								<span className={styles.headVolume}>{layer.volume}%</span>
								<button
									type="button"
									className={styles.mute}
									aria-label={`${label} 음소거`}
									aria-pressed={layer.muted}
									onClick={() => onCommit(layer.id, { muted: !layer.muted })}
								>
									{layer.muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
								</button>
							</div>
						);
					})}
				</div>
				<div className={styles.scroller} ref={scroller}>
					<div className={styles.canvas} ref={lanes} style={{ width: `${zoom * 100}%` }}>
						<div
							className={styles.ruler}
							data-testid="audio-ruler"
							onPointerDown={(event) => {
								seek(event);
								event.currentTarget.setPointerCapture?.(event.pointerId);
							}}
							onPointerMove={(event) => {
								if (event.buttons & 1) seek(event);
							}}
						>
							{ticks.map((sec) => (
								<span key={sec} className={styles.tick} style={{ left: pct(sec) }}>
									{formatSeconds(sec)}
								</span>
							))}
						</div>
						{layers.map((layer) => {
							const source = sources(layer);
							const span = layerSpanSec(layer);
							return (
								<div key={layer.id} className={styles.lane} onPointerDown={() => onSelect(null)}>
									<div
										role="button"
										tabIndex={0}
										aria-label={`${source.label} 레이어`}
										aria-pressed={layer.id === selectedId}
										className={styles.pill}
										data-kind={layer.kind}
										data-muted={layer.muted}
										data-missing={!source.url}
										style={{ left: pct(layer.startSec), width: pct(span) }}
										onPointerDown={(event) => startDrag(event, layer, "move")}
										onClick={() => onSelect(layer.id)}
										onPointerMove={moveDrag}
										onPointerUp={endDrag}
										onPointerCancel={endDrag}
										onKeyDown={(event) => {
											if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
												event.preventDefault();
												nudge(layer, event.key, event.shiftKey);
											} else if (event.key === "Enter" || event.key === " ") {
												event.preventDefault();
												onSelect(layer.id);
											}
										}}
									>
										<LayerWaveform
											url={source.url}
											durationSec={source.durationSec}
											inSec={layer.inSec}
											outSec={layer.outSec}
											gain={layer.volume / 100}
										/>
										{layer.fadeInSec > 0 ? (
											<span
												className={styles.fadeIn}
												style={{ width: `${Math.min(100, (layer.fadeInSec / span) * 100)}%` }}
											/>
										) : null}
										{layer.fadeOutSec > 0 ? (
											<span
												className={styles.fadeOut}
												style={{ width: `${Math.min(100, (layer.fadeOutSec / span) * 100)}%` }}
											/>
										) : null}
										<span className={styles.pillLabel}>
											{source.label} · {formatSeconds(span)}
										</span>
										<span
											className={styles.handle}
											data-edge="in"
											aria-label="앞부분 자르기"
											onPointerDown={(event) => startDrag(event, layer, "in")}
										/>
										<span
											className={styles.handle}
											data-edge="out"
											aria-label="뒷부분 자르기"
											onPointerDown={(event) => startDrag(event, layer, "out")}
										/>
									</div>
								</div>
							);
						})}
						<Playhead viewSec={viewSec} />
					</div>
				</div>
			</div>
		</section>
	);
}

/** Subscribes to the clock on its own, so playback moves one line instead of every row. */
function Playhead({ viewSec }: { viewSec: number }) {
	const time = useProjectStore((state) => state.currentTimeSec);
	return (
		<div
			className={styles.playhead}
			style={{ left: `${(Math.min(time, viewSec) / viewSec) * 100}%` }}
			aria-hidden
		/>
	);
}

/** The stretch of the file the layer plays, at its volume, clipped where the mix would clip. */
function LayerWaveform({
	url,
	durationSec,
	inSec,
	outSec,
	gain,
}: {
	url?: string;
	durationSec?: number;
	inSec: number;
	outSec: number;
	gain: number;
}) {
	const peaks = useAudioPeaks(url, durationSec);
	const bars = useMemo(() => {
		if (!peaks || peaks.length === 0 || !durationSec) return null;
		const blocks = Math.floor(peaks.length / 2);
		if (blocks === 0) return null;
		const perSec = blocks / durationSec;
		const first = Math.max(0, Math.floor(inSec * perSec));
		const last = Math.min(blocks, Math.ceil(outSec * perSec));
		const range = Math.max(1, last - first);
		const count = Math.min(400, Math.max(16, Math.round((outSec - inSec) * 8)));
		const result: number[] = [];
		for (let index = 0; index < count; index++) {
			const from = first + Math.floor((index / count) * range);
			const to = Math.max(from + 1, first + Math.floor(((index + 1) / count) * range));
			let amplitude = 0;
			for (let block = from; block < to && block < blocks; block++)
				amplitude = Math.max(
					amplitude,
					Math.abs(peaks[block * 2] ?? 0),
					Math.abs(peaks[block * 2 + 1] ?? 0),
				);
			result.push(amplitude);
		}
		return result;
	}, [peaks, durationSec, inSec, outSec]);
	if (!bars) return null;
	return (
		<div className={styles.wave} aria-hidden>
			{bars.map((amplitude, index) => {
				const level = Math.min(1, amplitude * gain);
				return <span key={index} style={{ height: `${Math.max(6, Math.round(level * 100))}%` }} />;
			})}
		</div>
	);
}
