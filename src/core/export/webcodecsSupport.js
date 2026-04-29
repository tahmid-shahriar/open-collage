import { EXPORT_DEFAULTS, EXPORT_LIMITS } from './constants.js'

export function validateExportInput({ width, height, fps }) {
  if (!Number.isFinite(width) || width < EXPORT_LIMITS.minWidth) {
    throw new Error(`Export width must be >= ${EXPORT_LIMITS.minWidth}.`)
  }
  if (!Number.isFinite(height) || height < EXPORT_LIMITS.minHeight) {
    throw new Error(`Export height must be >= ${EXPORT_LIMITS.minHeight}.`)
  }
  if (!Number.isFinite(fps) || fps < EXPORT_LIMITS.minFps || fps > EXPORT_LIMITS.maxFps) {
    throw new Error(`FPS must be between ${EXPORT_LIMITS.minFps} and ${EXPORT_LIMITS.maxFps}.`)
  }
}

export async function assertMp4ExportSupport({ width, height, fps, codec = null }) {
  validateExportInput({ width, height, fps })
  if (typeof VideoEncoder === 'undefined') {
    throw new Error('VideoEncoder API is unavailable in this browser.')
  }

  const candidates = codec
    ? [codec]
    : EXPORT_DEFAULTS.codecCandidates || [EXPORT_DEFAULTS.codec]

  for (const candidate of candidates) {
    const cfg = {
      codec: candidate,
      width,
      height,
      framerate: fps,
      bitrate: EXPORT_DEFAULTS.videoBitrate,
    }
    const support = await VideoEncoder.isConfigSupported(cfg)
    if (support?.supported) {
      return {
        ...support.config,
        codec: support.config?.codec || candidate,
      }
    }
  }

  throw new Error(
    `No supported MP4 H.264 codec profile found for ${width}x${height}@${fps}. Tried: ${candidates.join(', ')}`,
  )
}
