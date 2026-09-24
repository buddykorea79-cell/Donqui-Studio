import { describe, expect, it } from "vitest";
import type { VClipWindowAnalysis } from "./contract";
import {
	candidateWindows,
	clampSegmentSec,
	overlapRatio,
	provisionalSegments,
	rankSegments,
	selectedDurationSec,
	selectionToFill,
} from "./segments";

function analysis(
	startSec: number,
	endSec: number,
	score: number,
	qualityScore = 70,
): VClipWindowAnalysis {
	return {
		startSec,
		endSec,
		score,
		qualityScore,
		reason: "",
		quality: { brightness: 0.5, motion: 0.5, sharpness: 0.5, stability: 0.5 },
		ai: null,
		aiError: null,
		thumbnail: null,
	};
}

describe("candidateWindows", () => {
	it("covers a short source with one window no longer than the source", () => {
		expect(candidateWindows(3.456, 5)).toEqual([{ startSec: 0, endSec: 3.45 }]);
	});

	it("spreads windows over the whole source, first at 0 and last ending at the end", () => {
		const windows = candidateWindows(20, 5);
		expect(windows).toHaveLength(4);
		expect(windows[0]).toEqual({ startSec: 0, endSec: 5 });
		expect(windows.at(-1)).toEqual({ startSec: 15, endSec: 20 });
		for (const window of windows) expect(window.endSec - window.startSec).toBeCloseTo(5, 5);
	});

	it("thins a long source to the cap but keeps both ends of the footage", () => {
		const windows = candidateWindows(312.3, 5, 12);
		expect(windows).toHaveLength(12);
		expect(windows[0].startSec).toBe(0);
		expect(windows.at(-1)?.endSec).toBe(312.3);
		for (let index = 1; index < windows.length; index++)
			expect(windows[index].startSec).toBeGreaterThan(windows[index - 1].startSec);
	});

	it("never ends a window past the source, even on a fractional duration", () => {
		for (const window of candidateWindows(61.237, 7))
			expect(window.endSec).toBeLessThanOrEqual(61.237);
	});

	it("returns nothing for an unusable duration or cap", () => {
		expect(candidateWindows(0, 5)).toEqual([]);
		expect(candidateWindows(Number.NaN, 5)).toEqual([]);
		expect(candidateWindows(30, 5, 0)).toEqual([]);
	});

	it("clamps the window length to AutoVeo's 2–20 s bounds", () => {
		expect(clampSegmentSec(0.5)).toBe(2);
		expect(clampSegmentSec(90)).toBe(20);
		expect(clampSegmentSec(Number.NaN)).toBe(5);
		expect(candidateWindows(100, 90)[0]).toEqual({ startSec: 0, endSec: 20 });
	});
});

describe("ranking", () => {
	it("measures overlap against the shorter window", () => {
		expect(overlapRatio({ startSec: 0, endSec: 10 }, { startSec: 8, endSec: 12 })).toBeCloseTo(0.5);
		expect(overlapRatio({ startSec: 0, endSec: 5 }, { startSec: 5, endSec: 10 })).toBe(0);
	});

	it("drops a window overlapping a better one by more than 40%, then preselects the best three", () => {
		const ranked = rankSegments([
			analysis(0, 5, 70),
			analysis(2, 7, 90), // overlaps the 70 by 60 %: the 70 is dropped
			analysis(10, 15, 60),
			analysis(20, 25, 80),
			analysis(30, 35, 50),
		]);
		expect(ranked.map((segment) => segment.startSec)).toEqual([2, 10, 20, 30]);
		expect(ranked.filter((segment) => segment.selected).map((segment) => segment.score)).toEqual([
			90, 60, 80,
		]);
	});

	it("prefers the sharper, steadier window when the model scored them alike", () => {
		const ranked = rankSegments(
			[analysis(0, 5, 85, 60), analysis(10, 15, 85, 90), analysis(20, 25, 85, 75)],
			{ preselect: 1 },
		);
		expect(ranked.find((segment) => segment.selected)?.startSec).toBe(10);
		expect([...selectionToFill(ranked, 8)]).toEqual(["10.00-15.00", "20.00-25.00"]);
	});

	it("keeps provisional results in source order with nothing selected", () => {
		const provisional = provisionalSegments([analysis(10, 15, 90), analysis(0, 5, 40)]);
		expect(provisional.map((segment) => segment.startSec)).toEqual([0, 10]);
		expect(provisional.every((segment) => !segment.selected)).toBe(true);
		expect(provisional[0].id).toBe("0.00-5.00");
	});
});

describe("filling the audio bed", () => {
	const segments = rankSegments(
		[analysis(0, 5, 60), analysis(10, 15, 90), analysis(20, 24, 80), analysis(30, 35, 70)],
		{ preselect: 0 },
	);

	it("picks the best segments until they cover the time still missing", () => {
		const picked = selectionToFill(segments, 8);
		expect([...picked]).toEqual(["10.00-15.00", "20.00-24.00"]);
	});

	it("takes every segment when even all of them fall short", () => {
		expect(selectionToFill(segments, 600).size).toBe(4);
	});

	it("sums only the selected segments", () => {
		expect(selectedDurationSec(segments)).toBe(0);
		expect(
			selectedDurationSec(
				segments.map((segment) => ({ ...segment, selected: segment.startSec >= 20 })),
			),
		).toBe(9);
	});
});
