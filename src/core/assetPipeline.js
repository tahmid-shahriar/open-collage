export async function probeVideoMetadata(src) {
  const el = document.createElement('video')
  el.preload = 'metadata'
  el.src = src

  await new Promise((resolve, reject) => {
    el.onloadedmetadata = () => resolve()
    el.onerror = () => reject(new Error('video metadata probe failed'))
  })

  return {
    width: el.videoWidth,
    height: el.videoHeight,
    durationSec: Number.isFinite(el.duration) ? el.duration : 0,
    hasAudio: true,
  }
}

export async function probeImageMetadata(src) {
  const img = new Image()
  await new Promise((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('image metadata probe failed'))
    img.src = src
  })
  return {
    width: img.naturalWidth,
    height: img.naturalHeight,
    durationSec: 0,
    hasAudio: false,
  }
}

export function createNormalizedSource({ id, kind, src, meta }) {
  return { id, kind, src, meta }
}
