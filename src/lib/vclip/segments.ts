import { VCLIP_SEGMENT_LIMITS, type VClipWindowAnalysis } from "./contract";

export interface VClipWindow {
	startSec: number;
	endSec: number;
}

export interface VClipSegment extends VClipWindowAnalysis {
	id: string;
	selected: boolean;
}

/** Floors to centiseconds, so a window never ends past the source it was cut from. */
const floor2 = (value: number) => Math.floor(value * 100 + 1e-6) / 100;

export function clampSegmentSec(value: number): number {
	if (!Number.isFinite(value)) return VCLIP_SEGMENT_LIMITS.defaultSec;
	return Math.min(VCLIP_SEGMENT_LIMITS.maxSec, Math.max(VCLIP_SEGMENT_LIMITS.minSec, value));
}

/**
 * AutoVeo's candidate windows: `segmentSec`-long windows spread evenly over the source (they
 * touch or barely overlap), thinned to `maxCount` that still include both ends of the footage.
 */
export function candidateWindows(
	durationSec: number,
	segmentSec: number,
	maxCount: number = VCLIP_SEGMENT_LIMITS.maxCandidates,
): VClipWindow[] {
	if (!Number.isFinite(durationSec) || durationSec <= 0 || maxCount < 1) return [];
	const length = clampSegmentSec(segmentSec);
	const end = floor2(durationSec);
	if (durationSec <= length) return [{ startSec: 0, endSec: end }];
	const count = Math.max(2, Math.ceil((durationSec - length) / length) + 1);
	const windows = Array.from({ length: count }, (_, index) => {
		const startSec = floor2(((durationSec - length) * index) / (count - 1));
		return { startSec, endSec: Math.min(end, floor2(startSec + length)) };
	});
	if (windows.length <= maxCount) return windows;
	if (maxCount === 1) return [windows[0]];
	return Array.from(
		{ length: maxCount },
		(_, index) => windows[Math.round((index * (windows.length - 1)) / (maxCount - 1))],
	);
}

export function segmentId(window: VClipWindow): string {
	return `${window.startSec.toFixed(2)}-${window.endSec.toFixed(2)}`;
}

/** The share of the shorter window that both cover. */
export function overlapRatio(left: VClipWindow, right: VClipWindow): number {
	const shared = Math.min(left.endSec, right.endSec) - Math.max(left.startSec, right.startSec);
	const shortest = Math.min(left.endSec - left.startSec, right.endSec - right.startSec);
	return shared > 0 && shortest > 0 ? shared / shortest : 0;
}

/**
 * Best first: the score, then frame quality where the model scored alike, then the earlier
 * window.
 */
export function byMerit(left: VClipWindowAnalysis, right: VClipWindowAnalysis): number {
	return (
		right.score - left.score ||
		right.qualityScore - left.qualityScore ||
		left.startSec - right.startSec
	);
}

/** Windows as they arrive during a run: in source order, nothing selected yet. */
export function provisionalSegments(analyses: VClipWindowAnalysis[]): VClipSegment[] {
	return analyses
		.map((analysis) => ({ ...analysis, id: segmentId(analysis), selected: false }))
		.sort((left, right) => left.startSec - right.startSec);
}

/**
 * AutoVeo's choice: best first ({@link byMerit}), a window overlapping a better one by more
 * than 40 % of the shorter is dropped, and the top `preselect` start out selected. Returned in
 * source order.
 */
export function rankSegments(
	analyses: VClipWindowAnalysis[],
	options: { maxKeep?: number; preselect?: number } = {},
): VClipSegment[] {
	const maxKeep = options.maxKeep ?? VCLIP_SEGMENT_LIMITS.maxKeep;
	const preselect = options.preselect ?? VCLIP_SEGMENT_LIMITS.preselect;
	const chosen: VClipWindowAnalysis[] = [];
	for (const analysis of [...analyses].sort(byMerit)) {
		if (chosen.length >= maxKeep) break;
		if (chosen.some((other) => overlapRatio(other, analysis) > 0.4)) continue;
		chosen.push(analysis);
	}
	const best = new Set(chosen.slice(0, preselect));
	return chosen
		.map((analysis) => ({ ...analysis, id: segmentId(analysis), selected: best.has(analysis) }))
		.sort((left, right) => left.startSec - right.startSec);
}

export function selectedDurationSec(segments: VClipSegment[]): number {
	return segments
		.filter((segment) => segment.selected)
		.reduce((sum, segment) => sum + segment.endSec - segment.startSec, 0);
}

/**
 * Best-scored segments until they cover `targetSec` — the picture still missing under the
 * audio bed. Every segment when even all of them fall short.
 */
export function selectionToFill(segments: VClipSegment[], targetSec: number): Set<string> {
	const picked = new Set<string>();
	let total = 0;
	for (const segment of [...segments].sort(byMerit)) {
		if (total >= targetSec) break;
		picked.add(segment.id);
		total += segment.endSec - segment.startSec;
	}
	return picked;
}
