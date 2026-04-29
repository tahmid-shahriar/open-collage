import { ArrayBufferTarget, Muxer } from 'mp4-muxer'

export function createMp4Muxer({ width, height, fps }) {
  const target = new ArrayBufferTarget()
  const muxer = new Muxer({
    target,
    video: {
      codec: 'avc',
      width,
      height,
      frameRate: fps,
    },
    fastStart: 'in-memory',
  })
  return { muxer, target }
}
