export const EXPORT_LIMITS = {
  minWidth: 320,
  minHeight: 240,
  maxWidth: 7680,
  maxHeight: 4320,
  minFps: 15,
  maxFps: 60,
}

export const EXPORT_DEFAULTS = {
  fps: 30,
  videoBitrate: 8_000_000,
  keyframeIntervalSec: 2,
  codec: 'avc1.42E01E',
  codecCandidates: [
    'avc1.42E01E',
    'avc1.42001E',
    'avc1.4D401F',
    'avc1.640028',
  ],
}

export const EXPORT_QUEUE_LIMITS = {
  maxPendingVideoFrames: 12,
  maxPendingEncodedChunks: 24,
}
