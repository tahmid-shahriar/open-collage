export function frameIndexToSec(frameIndex, fps) {
  return frameIndex / fps
}

export function secToFrameIndex(timeSec, fps) {
  return Math.max(0, Math.floor(timeSec * fps))
}

export function resolveClipSourceTimeSec(clip, timelineSec, sourceDurationSec) {
  const trimStart = clip.trimStartSec ?? 0
  const trimEnd = clip.trimEndSec ?? sourceDurationSec
  const clipLen = Math.max(0, trimEnd - trimStart)
  if (clipLen <= 0) return trimStart
  const local = Math.min(clipLen, Math.max(0, timelineSec))
  return trimStart + local
}
