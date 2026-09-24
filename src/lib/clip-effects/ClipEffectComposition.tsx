import { AbsoluteFill, OffthreadVideo, useCurrentFrame, useVideoConfig } from "remotion";
import type { ClipEffectProps } from "./catalog";
import { clipEffectStyle } from "./motion";

export function ClipEffectComposition({ sourceUrl, startMs, effect }: ClipEffectProps) {
	const frame = useCurrentFrame();
	const { fps, durationInFrames } = useVideoConfig();
	return (
		<AbsoluteFill style={{ overflow: "hidden", backgroundColor: "black" }}>
			<AbsoluteFill style={clipEffectStyle(effect, frame, durationInFrames, fps)}>
				<OffthreadVideo
					src={sourceUrl}
					trimBefore={Math.round((startMs / 1000) * fps)}
					style={{ width: "100%", height: "100%", objectFit: "contain" }}
				/>
			</AbsoluteFill>
		</AbsoluteFill>
	);
}
