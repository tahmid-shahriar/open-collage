import { createMp4Muxer } from './mp4MuxerAdapter.js'
import { EXPORT_DEFAULTS } from './constants.js'
import { ExportStageError } from './errors.js'
import { assertMp4ExportSupport } from './webcodecsSupport.js'

function asAbortError() {
  return new ExportStageError('cancelled', 'Export cancelled by user.')
}

export async function runMp4Export({
  composition,
  canvas,
  drawFrame,
  onProgress,
  signal,
}) {
  const { width, height, fps, durationSec } = composition
  if (signal?.aborted) throw asAbortError()

  const supportedConfig = await assertMp4ExportSupport({
    width,
    height,
    fps,
  })

  const { muxer, target } = createMp4Muxer({ width, height, fps })
  let frameCount = 0
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      muxer.addVideoChunk(chunk, meta)
    },
    error: (err) => {
      throw new ExportStageError('encode', `Encoder failure: ${err?.message || 'unknown'}`, err)
    },
  })

  encoder.configure({
    ...supportedConfig,
    bitrate: EXPORT_DEFAULTS.videoBitrate,
    framerate: fps,
  })

  const totalFrames = Math.max(1, Math.ceil(durationSec * fps))
  const keyframeEvery = Math.max(1, Math.round(fps * EXPORT_DEFAULTS.keyframeIntervalSec))

  for (let i = 0; i < totalFrames; i++) {
    if (signal?.aborted) {
      encoder.close()
      throw asAbortError()
    }

    const elapsedSec = i / fps
    await drawFrame(elapsedSec, i, totalFrames)

    const frame = new VideoFrame(canvas, {
      timestamp: Math.round(elapsedSec * 1_000_000),
      duration: Math.round((1 / fps) * 1_000_000),
    })
    encoder.encode(frame, { keyFrame: i % keyframeEvery === 0 })
    frame.close()
    frameCount++

    if (typeof onProgress === 'function') {
      onProgress(Math.min(100, (frameCount / totalFrames) * 100))
    }
  }

  await encoder.flush()
  encoder.close()
  muxer.finalize()

  return new Blob([target.buffer], { type: 'video/mp4' })
}
