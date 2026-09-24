import { AbsoluteFill, Img, OffthreadVideo, useCurrentFrame, useVideoConfig } from "remotion";
import type { ClipEffectProps } from "./catalog";
import { clipEffectStyle } from "./motion";

export function ClipEffectComposition({
	sourceUrl,
	startMs,
	effect,
	sourceKind = "video",
}: ClipEffectProps) {
	const frame = useCurrentFrame();
	const { fps, durationInFrames } = useVideoConfig();
	const fill = { width: "100%", height: "100%", objectFit: "contain" } as const;
	return (
		<AbsoluteFill style={{ overflow: "hidden", backgroundColor: "black" }}>
			<AbsoluteFill style={clipEffectStyle(effect, frame, durationInFrames, fps)}>
				{sourceKind === "image" ? (
					<Img src={sourceUrl} style={fill} />
				) : (
					<OffthreadVideo
						src={sourceUrl}
						trimBefore={Math.round((startMs / 1000) * fps)}
						style={fill}
					/>
				)}
			</AbsoluteFill>
		</AbsoluteFill>
	);
}
