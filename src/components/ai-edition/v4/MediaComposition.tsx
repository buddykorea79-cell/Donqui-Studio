import {
	ArrowDown,
	ArrowUp,
	AudioLines,
	Film,
	Image as ImageIcon,
	Play,
	Shuffle,
	Square,
	Trash2,
	WandSparkles,
	X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { toFileUrl } from "@/components/video-editor/projectPersistence";
import { collapseTracksToPills } from "@/lib/ai-edition/document/audioTracks";
import type {
	AxcutAsset,
	AxcutDocument,
	AxcutMediaBoardImage,
	AxcutMediaBoardItem,
} from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { formatSec, formatSeconds } from "@/lib/ai-edition/timeline/format";
import { audioBoardOf, isAudible, mixStatus, playsBoardMix } from "@/lib/audio-board/board";
import { audioFitSummary } from "@/lib/clip-effects/audioFit";
import { CLIP_EFFECTS, type ClipEffectSelection } from "@/lib/clip-effects/catalog";
import { clipEffectLabel, itemNeedsRender } from "@/lib/media-board/apply";
import {
	boardOf,
	clearBoardItems,
	itemDurationSec,
	itemEffect,
	MAX_IMAGE_SEC,
	MIN_ITEM_SEC,
	moveBoardItem,
	removeBoardItem,
	reshuffleRandomItems,
	resolvedItemEffect,
	setAllItemsEffect,
	setBoardItemRanges,
	updateBoardItem,
} from "@/lib/media-board/board";
import {
	fitComposition,
	itemWithDuration,
	type NarrationSpeech,
	narrationPauses,
	narrationSpeech,
} from "@/lib/media-board/fit";
import { mutateDocument } from "@/lib/media-board/mutate";
import { useComposeStore } from "@/lib/media-board/store";
import { useThumbnail } from "@/lib/media-board/thumbnails";
import { useVClipStore, vclipKey } from "@/lib/vclip/store";
import { ClipPreview } from "./ClipPreview";
import styles from "./MediaStage.module.css";

export function EffectOptions() {
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

function edit(change: (document: AxcutDocument) => AxcutDocument) {
	void mutateDocument(change, { history: true }).catch((error: unknown) => {
		toast.error("조합을 저장하지 못했습니다.", {
			description: error instanceof Error ? error.message : String(error),
		});
	});
}

/** A source's length: the project's own record, else what FFmpeg read for V.Clip. */
function useSourceDurations(): (item: Pick<AxcutMediaBoardItem, "assetId">) => number | undefined {
	const document = useProjectStore((state) => state.document);
	const projectId = useProjectStore((state) => state.projectId);
	const probes = useVClipStore((state) => state.probes);
	return useMemo(() => {
		const assets = new Map((document?.assets ?? []).map((asset) => [asset.id, asset]));
		return (item) => {
			if (!item.assetId) return undefined;
			return (
				assets.get(item.assetId)?.durationSec ||
				probes[vclipKey(projectId, item.assetId)]?.durationSec ||
				undefined
			);
		};
	}, [document?.assets, probes, projectId]);
}

/**
 * Media's composition: the clips, photos and videos that will make up the picture, in order,
 * each with its own Remotion effect and length. It is fitted to the Audio tab's soundtrack —
 * cuts on the narration's pauses when there is one — and rendered onto the timeline in one go.
 */
export function MediaComposition({
	defaultEffect,
	onDefaultEffect,
}: {
	defaultEffect: ClipEffectSelection;
	onDefaultEffect: (effect: ClipEffectSelection) => void;
}) {
	const document = useProjectStore((state) => state.document);
	const applying = useComposeStore((state) => state.applying);
	const [previewId, setPreviewId] = useState<string | null>(null);
	const [confirmReplace, setConfirmReplace] = useState(false);
	const [snapToNarration, setSnapToNarration] = useState(true);
	const sourceDuration = useSourceDurations();
	const board = boardOf(document);
	const items = board.items;
	const totalSec = items.reduce((sum, item) => sum + itemDurationSec(item), 0);
	const audioSec = document ? audioFitSummary(document).audioMs / 1000 : 0;
	const speech = useMemo(() => (document ? narrationSpeech(document) : []), [document]);
	const pauses = useMemo(() => (document ? narrationPauses(document) : []), [document]);
	const toRender = items.filter(itemNeedsRender).length;
	const timelineClips = document?.timeline.clips.length ?? 0;
	const locked = Boolean(applying);

	// Whole videos and clips need their source length to be stretched; ask FFmpeg for the ones
	// the project does not know yet.
	useEffect(() => {
		for (const asset of document?.assets ?? []) {
			if (asset.durationSec || !items.some((item) => item.assetId === asset.id)) continue;
			void useVClipStore.getState().probe(asset);
		}
	}, [document?.assets, items]);

	const fitToAudio = () => {
		if (!document || items.length === 0 || audioSec <= 0) return;
		const result = fitComposition(items, audioSec, sourceDuration, {
			pausesSec: snapToNarration ? pauses : [],
		});
		edit((current) => setBoardItemRanges(current, result.ranges));
		if (result.shortSec > 0)
			toast.warning(`영상이 ${formatSeconds(result.shortSec)} 모자랍니다.`, {
				description: "모든 항목을 최대로 늘렸습니다. 클립이나 사진을 더 넣으세요.",
			});
		else if (result.overSec > 0)
			toast.warning(`항목이 많아 ${formatSeconds(result.overSec)} 넘칩니다.`, {
				description: `모든 항목을 ${MIN_ITEM_SEC}초로 줄였습니다. 몇 개를 빼세요.`,
			});
		else {
			const notes = [
				result.snapped ? "나레이션이 쉬는 곳으로 컷을 옮겼습니다." : "",
				result.reused
					? "쓰지 않은 원본이 모자라 일부 클립이 다른 클립과 같은 장면을 다시 씁니다. 클립이나 사진을 더 넣으면 겹치지 않습니다."
					: "",
			].filter(Boolean);
			const message = `조합을 Audio 길이 ${formatSeconds(audioSec)}에 맞췄습니다.`;
			if (result.reused) toast.warning(message, { description: notes.join(" ") });
			else toast.success(message, notes.length > 0 ? { description: notes.join(" ") } : undefined);
		}
	};

	const startApply = (mode: "replace" | "append") => {
		setConfirmReplace(false);
		void useComposeStore.getState().apply(mode);
	};

	return (
		<section className={styles.composition} aria-label="조합">
			<div className={styles.sectionHead}>
				<h2>조합</h2>
				<span className={styles.hint}>
					항목 {items.length}개 · {formatSec(totalSec)}
				</span>
				{items.length > 0 ? (
					<button
						type="button"
						className={styles.textButton}
						disabled={locked}
						onClick={() => edit(clearBoardItems)}
					>
						모두 비우기
					</button>
				) : null}
			</div>

			<AudioFit
				document={document}
				items={items}
				totalSec={totalSec}
				audioSec={audioSec}
				speech={speech}
				pauseCount={pauses.length}
				snap={snapToNarration}
				onSnap={setSnapToNarration}
				disabled={locked}
				onFit={fitToAudio}
			/>

			<div className={styles.effectBar}>
				<label className={styles.inline}>
					새 항목 효과
					<select
						aria-label="새 항목 효과"
						value={defaultEffect}
						onChange={(event) => onDefaultEffect(event.target.value as ClipEffectSelection)}
					>
						<EffectOptions />
					</select>
				</label>
				<button
					type="button"
					className={styles.button}
					disabled={locked || items.length === 0}
					onClick={() => edit((current) => setAllItemsEffect(current, defaultEffect))}
				>
					모든 항목에 적용
				</button>
				{items.some((item) => itemEffect(item) === "random") ? (
					<button
						type="button"
						className={styles.button}
						disabled={locked}
						onClick={() => edit(reshuffleRandomItems)}
					>
						<Shuffle size={14} />
						랜덤 다시 섞기
					</button>
				) : null}
			</div>

			{items.length === 0 ? (
				<div className={styles.empty}>
					<WandSparkles size={28} />
					<strong>왼쪽에서 클립·사진·영상을 조합에 넣으세요</strong>
					<p className={styles.hint}>
						넣은 순서대로 타임라인에 놓입니다. 항목마다 Remotion 효과와 길이를 정하고, Audio가
						있으면 그 길이에 맞출 수 있습니다.
					</p>
				</div>
			) : (
				<ol className={styles.items}>
					{items.map((item, index) => (
						<ItemRow
							key={item.id}
							item={item}
							index={index}
							count={items.length}
							asset={document?.assets.find((asset) => asset.id === item.assetId)}
							image={board.images.find((image) => image.id === item.imageId)}
							sourceDurationSec={sourceDuration(item)}
							locked={locked}
							previewing={previewId === item.id}
							onPreview={() => setPreviewId(previewId === item.id ? null : item.id)}
						/>
					))}
				</ol>
			)}

			<div className={styles.applyBar}>
				<span className={styles.hint}>
					{toRender > 0
						? `효과·사진 ${toRender}개는 적용할 때 렌더링합니다. 한 번 만든 결과는 다시 쓰입니다.`
						: "효과 없는 클립은 원본에서 바로 재생되어 렌더링이 필요 없습니다."}
				</span>
				{applying ? (
					<div className={styles.applying} role="status">
						<div
							className={styles.progress}
							role="progressbar"
							aria-label="조합 렌더링"
							aria-valuemin={0}
							aria-valuemax={applying.total || 1}
							aria-valuenow={applying.done}
						>
							<span
								style={{
									width: `${applying.total ? (applying.done / applying.total) * 100 : 0}%`,
								}}
							/>
						</div>
						<span>
							{applying.total > 0 && applying.done < applying.total
								? `렌더링 ${applying.done + 1} / ${applying.total} · ${applying.label}`
								: "타임라인에 놓는 중…"}
						</span>
						<button
							type="button"
							className={styles.button}
							onClick={() => useComposeStore.getState().cancel()}
						>
							<Square size={13} />
							멈추기
						</button>
					</div>
				) : confirmReplace ? (
					<div className={styles.confirm} role="alertdialog" aria-label="타임라인 바꾸기">
						<p>
							타임라인의 클립 {timelineClips}개를 이 조합으로 바꿉니다. 그 클립에 붙은 줌·자막 같은
							편집도 함께 사라집니다. Audio는 그대로이고, 실행 취소로 되돌릴 수 있습니다.
						</p>
						<div className={styles.row}>
							<button
								type="button"
								className={`${styles.button} ${styles.primary}`}
								onClick={() => startApply("replace")}
							>
								바꾸기
							</button>
							<button
								type="button"
								className={styles.button}
								onClick={() => setConfirmReplace(false)}
							>
								취소
							</button>
						</div>
					</div>
				) : (
					<div className={styles.row}>
						<button
							type="button"
							className={`${styles.button} ${styles.primary}`}
							disabled={items.length === 0}
							onClick={() => (timelineClips > 0 ? setConfirmReplace(true) : startApply("replace"))}
						>
							<WandSparkles size={15} />
							타임라인에 적용
						</button>
						<button
							type="button"
							className={styles.button}
							disabled={items.length === 0 || timelineClips === 0}
							onClick={() => startApply("append")}
						>
							타임라인 끝에 추가
						</button>
					</div>
				)}
			</div>
		</section>
	);
}

function AudioFit({
	document,
	items,
	totalSec,
	audioSec,
	speech,
	pauseCount,
	snap,
	onSnap,
	disabled,
	onFit,
}: {
	document: AxcutDocument | null;
	items: AxcutMediaBoardItem[];
	totalSec: number;
	audioSec: number;
	speech: NarrationSpeech[];
	pauseCount: number;
	snap: boolean;
	onSnap: (value: boolean) => void;
	disabled: boolean;
	onFit: () => void;
}) {
	const tracks = collapseTracksToPills(document?.audioTracks ?? []).filter((track) => !track.muted);
	const endOf = (kind: "music" | "voiceover") =>
		Math.max(
			0,
			...tracks.filter((track) => track.kind === kind).map((track) => track.endMs / 1000),
		);
	// The Audio tab's mix is one track; what it was made of is on the board.
	const mixed = playsBoardMix(document);
	const layers = mixed ? audioBoardOf(document).layers.filter(isAudible) : [];
	const countOf = (kind: "music" | "voiceover") =>
		layers.filter((layer) => layer.kind === kind).length;
	const breakdown = mixed
		? [
				" · 오디오 믹스",
				countOf("music") > 0 ? ` · 음악 ${countOf("music")}개` : "",
				countOf("voiceover") > 0 ? ` · 나레이션 ${countOf("voiceover")}개` : "",
			].join("")
		: [
				endOf("music") > 0 ? ` · 음악 ${formatSeconds(endOf("music"))}` : "",
				endOf("voiceover") > 0 ? ` · 나레이션 ${formatSeconds(endOf("voiceover"))}` : "",
			].join("");
	const narration = mixed ? countOf("voiceover") : endOf("voiceover");
	const status = mixStatus(document);
	const pending = status === "unapplied" || status === "changed";
	const difference = audioSec - totalSec;
	if (audioSec <= 0)
		return (
			<p className={styles.fitNote}>
				<AudioLines size={14} />
				{pending
					? "Audio 탭에서 ‘Media에 반영’을 누르면 조합을 그 오디오 길이에 맞출 수 있습니다."
					: "Audio 탭에 음악이나 나레이션을 넣으면 조합을 그 길이에 맞출 수 있습니다."}
			</p>
		);
	const span = Math.max(audioSec, totalSec, 0.001);
	let cursor = 0;
	return (
		<div className={styles.fit}>
			<p>
				<AudioLines size={14} />
				<span>
					Audio <strong>{formatSeconds(audioSec)}</strong>
					{breakdown}
				</span>
				<span>
					조합 <strong>{formatSeconds(totalSec)}</strong>
				</span>
				<span data-tone={Math.abs(difference) < 0.05 ? "ok" : "off"}>
					{Math.abs(difference) < 0.05
						? "길이가 맞습니다"
						: difference > 0
							? `${formatSeconds(difference)} 모자람`
							: `${formatSeconds(-difference)} 넘침`}
				</span>
			</p>
			{pending ? (
				<p className={styles.fitPending} role="status">
					Audio 탭에서 바꾼 오디오가 아직 반영되지 않았습니다. Audio 탭에서 ‘Media에 반영’을
					누르세요.
				</p>
			) : null}
			<div className={styles.fitBar} aria-hidden>
				<div className={styles.fitLane}>
					{items.map((item, index) => {
						const left = cursor;
						cursor += itemDurationSec(item);
						return (
							<span
								key={item.id}
								data-kind={item.kind}
								data-odd={index % 2 === 1}
								style={{
									left: `${(left / span) * 100}%`,
									width: `${(itemDurationSec(item) / span) * 100}%`,
								}}
							/>
						);
					})}
				</div>
				<div className={styles.fitLane}>
					<span data-kind="audio" style={{ left: 0, width: `${(audioSec / span) * 100}%` }} />
					{speech.flatMap(({ spoken }) =>
						spoken.map((part) => (
							<span
								key={`${part.startSec}-${part.endSec}`}
								data-kind="speech"
								style={{
									left: `${(part.startSec / span) * 100}%`,
									width: `${((part.endSec - part.startSec) / span) * 100}%`,
								}}
							/>
						)),
					)}
				</div>
			</div>
			<div className={styles.row}>
				<button
					type="button"
					className={`${styles.button} ${styles.primary}`}
					disabled={disabled || items.length === 0}
					onClick={onFit}
				>
					Audio 길이에 맞추기
				</button>
				{pauseCount > 0 ? (
					<label className={styles.inline}>
						<input
							type="checkbox"
							checked={snap}
							onChange={(event) => onSnap(event.target.checked)}
						/>
						나레이션이 쉬는 곳에 컷 맞추기 ({pauseCount}곳)
					</label>
				) : narration > 0 ? (
					<span className={styles.hint}>
						나레이션 받아쓰기가 끝나면 말이 쉬는 곳에 컷을 맞출 수 있습니다.
					</span>
				) : null}
			</div>
		</div>
	);
}

function ItemRow({
	item,
	index,
	count,
	asset,
	image,
	sourceDurationSec,
	locked,
	previewing,
	onPreview,
}: {
	item: AxcutMediaBoardItem;
	index: number;
	count: number;
	asset: AxcutAsset | undefined;
	image: AxcutMediaBoardImage | undefined;
	sourceDurationSec: number | undefined;
	locked: boolean;
	previewing: boolean;
	onPreview: () => void;
}) {
	const effect = itemEffect(item);
	const resolved = resolvedItemEffect(item);
	const durationSec = itemDurationSec(item);
	const missing = item.kind === "image" ? !image : !asset;
	const thumbnail = useThumbnail(
		item.kind === "image" ? null : (asset?.originalPath ?? null),
		item.startSec + durationSec / 2,
	);
	const maxSec = item.kind === "image" ? MAX_IMAGE_SEC : (sourceDurationSec ?? durationSec);
	const kind = item.kind === "image" ? "사진" : item.kind === "clip" ? "클립" : "영상";

	return (
		<li className={styles.item} data-missing={missing}>
			<div className={styles.itemMain}>
				<span className={styles.index}>{index + 1}</span>
				<div className={styles.itemThumb}>
					{item.kind === "image" && image ? (
						<img src={toFileUrl(image.path)} alt="" draggable={false} />
					) : thumbnail ? (
						<img src={thumbnail} alt="" draggable={false} />
					) : item.kind === "image" ? (
						<ImageIcon size={18} />
					) : (
						<Film size={18} />
					)}
				</div>
				<div className={styles.itemText}>
					<strong title={item.label}>{item.label}</strong>
					<span>
						{kind}
						{item.kind === "image"
							? ""
							: ` · ${formatSec(item.startSec)}–${formatSec(item.endSec)}`}
						{missing ? " · 파일이 프로젝트에 없습니다" : ""}
					</span>
				</div>
				<DurationField
					label={`${index + 1}번 길이 (초)`}
					value={durationSec}
					max={maxSec}
					disabled={locked}
					onCommit={(value) =>
						edit((current) =>
							updateBoardItem(current, item.id, itemWithDuration(item, value, sourceDurationSec)),
						)
					}
				/>
				<select
					aria-label={`${index + 1}번 효과`}
					className={styles.effectSelect}
					value={effect}
					disabled={locked}
					title={effect === "random" ? `랜덤 → ${clipEffectLabel(resolved)}` : undefined}
					onChange={(event) => {
						// Read now: the write runs on the queue, after React has put the controlled
						// select back to the value it still renders.
						const next = event.target.value as ClipEffectSelection;
						edit((current) => updateBoardItem(current, item.id, { effect: next }));
					}}
				>
					<EffectOptions />
				</select>
				<div className={styles.itemActions}>
					<button
						type="button"
						aria-label={`${index + 1}번 미리보기`}
						aria-pressed={previewing}
						disabled={missing}
						onClick={onPreview}
					>
						{previewing ? <X size={14} /> : <Play size={14} />}
					</button>
					<button
						type="button"
						aria-label={`${index + 1}번 위로`}
						disabled={locked || index === 0}
						onClick={() => edit((current) => moveBoardItem(current, item.id, index - 1))}
					>
						<ArrowUp size={14} />
					</button>
					<button
						type="button"
						aria-label={`${index + 1}번 아래로`}
						disabled={locked || index === count - 1}
						onClick={() => edit((current) => moveBoardItem(current, item.id, index + 1))}
					>
						<ArrowDown size={14} />
					</button>
					<button
						type="button"
						aria-label={`${index + 1}번 빼기`}
						disabled={locked}
						onClick={() => edit((current) => removeBoardItem(current, item.id))}
					>
						<Trash2 size={14} />
					</button>
				</div>
			</div>
			{effect === "random" ? (
				<p className={styles.itemNote}>랜덤 → {clipEffectLabel(resolved)}</p>
			) : null}
			{previewing && !missing ? (
				<div className={styles.itemPreview}>
					<ItemPreview item={item} asset={asset} image={image} />
				</div>
			) : null}
		</li>
	);
}

function ItemPreview({
	item,
	asset,
	image,
}: {
	item: AxcutMediaBoardItem;
	asset: AxcutAsset | undefined;
	image: AxcutMediaBoardImage | undefined;
}) {
	const effect = resolvedItemEffect(item);
	if (item.kind === "image" && image)
		return (
			<ClipPreview
				sourceUrl={toFileUrl(image.path)}
				sourceKind="image"
				startMs={0}
				endMs={Math.round(itemDurationSec(item) * 1000)}
				effect={effect}
				width={image.width}
				height={image.height}
			/>
		);
	if (!asset) return null;
	return (
		<ClipPreview
			sourceUrl={toFileUrl(asset.originalPath)}
			startMs={Math.round(item.startSec * 1000)}
			endMs={Math.round(item.endSec * 1000)}
			effect={effect}
			width={asset.video?.width || undefined}
			height={asset.video?.height || undefined}
		/>
	);
}

function DurationField({
	label,
	value,
	max,
	disabled,
	onCommit,
}: {
	label: string;
	value: number;
	max: number;
	disabled: boolean;
	onCommit: (value: number) => void;
}) {
	const rounded = Math.round(value * 100) / 100;
	const [draft, setDraft] = useState(String(rounded));
	useEffect(() => setDraft(String(rounded)), [rounded]);
	const commit = () => {
		const parsed = Number(draft);
		if (Number.isFinite(parsed) && parsed >= MIN_ITEM_SEC && Math.abs(parsed - rounded) > 0.001)
			onCommit(Math.min(max, parsed));
		else setDraft(String(rounded));
	};
	return (
		<label className={styles.duration}>
			<input
				type="number"
				aria-label={label}
				min={MIN_ITEM_SEC}
				max={max}
				step={0.1}
				value={draft}
				disabled={disabled}
				onChange={(event) => setDraft(event.target.value)}
				onBlur={commit}
				onKeyDown={(event) => {
					if (event.key === "Enter") commit();
				}}
			/>
			초
		</label>
	);
}
