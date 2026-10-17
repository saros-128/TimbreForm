export type SceneQuality = "auto" | "high" | "economy";
export function sceneBufferSize(
  width: number,
  height: number,
  dpr: number,
  quality: SceneQuality,
  scale = 1,
) {
  const budget =
    quality === "high"
      ? 4_000_000
      : quality === "economy"
        ? 650_000
        : 1_800_000;
  const ratio =
    Math.max(
      0.1,
      Math.min(
        Math.max(1, dpr),
        Math.sqrt(budget / Math.max(1, width * height)),
      ),
    ) * Math.max(0.4, Math.min(1, scale));
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
    ratio,
  };
}
