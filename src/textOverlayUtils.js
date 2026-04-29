/** @typedef {{ id: string, text: string, nx: number, ny: number, nw: number, nh: number, color: string, fontPx: number, animation: string }} TextOverlay */

export const TEXT_ANIMATIONS = [
  { value: 'none', label: 'None' },
  { value: 'fadeIn', label: 'Fade in' },
  { value: 'pulse', label: 'Pulse' },
  { value: 'slideUp', label: 'Slide up' },
  { value: 'bounce', label: 'Bounce' },
  { value: 'typewriter', label: 'Typing' },
]

const REF_WIDTH = 1080

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v))
}

/**
 * Animation state for canvas at elapsed seconds (from export start).
 * @returns {{ opacity: number, offsetX: number, offsetY: number }}
 */
export function textAnimationState(animation, elapsedSec, boxW, boxH) {
  const e = Math.max(0, elapsedSec)
  const bh = boxH && boxH > 0 ? boxH : 400
  const bw = boxW && boxW > 0 ? boxW : 400
  switch (animation) {
    case 'fadeIn': {
      const dur = 1.2
      return { opacity: Math.min(1, e / dur), offsetX: 0, offsetY: 0 }
    }
    case 'pulse':
      return {
        opacity: 0.55 + 0.45 * Math.sin(e * 3.2),
        offsetX: 0,
        offsetY: 0,
      }
    case 'slideUp': {
      const dur = 1
      const t = Math.min(1, e / dur)
      // Vertical motion scales with box height (old formula used width and could push text past clip).
      const maxSlide = Math.min(0.12 * bw, 0.35 * bh)
      return {
        opacity: t,
        offsetX: 0,
        offsetY: (1 - t) * maxSlide,
      }
    }
    case 'bounce':
      return {
        opacity: 1,
        offsetX: 0,
        offsetY: Math.sin(e * 4) * 0.012 * bw,
      }
    case 'typewriter':
      return { opacity: 1, offsetX: 0, offsetY: 0 }
    default:
      return { opacity: 1, offsetX: 0, offsetY: 0 }
  }
}

/** Seconds to reveal full string (matches preview). */
export function typewriterDurationSec(text) {
  const len = String(text || '').length
  if (len <= 0) return 0.35
  return Math.max(0.35, Math.min(16, len * 0.055))
}

/**
 * Visible substring for typing animation at elapsed seconds.
 */
export function applyTypingSlice(text, animation, elapsedSec) {
  const t = String(text || '')
  if (animation !== 'typewriter') return t
  const dur = typewriterDurationSec(t)
  if (dur <= 0) return t
  const p = Math.min(1, Math.max(0, elapsedSec) / dur)
  const n = Math.floor(t.length * p)
  return t.slice(0, n)
}

/**
 * Shrink font until one line (height = fontSize * 1.25) fits inside the padded box.
 * Export used to scale only by full canvas width; tiny overlays (preview uses 9–72px)
 * then had line height > box height, so nothing was drawn.
 */
function fitFontSizeToBox(boxW, boxH, baseFontPx) {
  let fontSize = Math.max(8, baseFontPx)
  if (!(boxW > 0) || !(boxH > 0)) return fontSize
  for (let i = 0; i < 16; i++) {
    const pad = Math.max(4, fontSize * 0.15)
    const innerH = boxH - pad * 2
    if (innerH <= 0) {
      return Math.max(2, Math.min(fontSize, boxH * 0.4))
    }
    const lineHeight = fontSize * 1.25
    if (lineHeight <= innerH) return Math.max(2, fontSize)
    const next = innerH / 1.25
    if (next >= fontSize - 0.001) return Math.max(2, fontSize)
    fontSize = Math.max(2, next)
  }
  return Math.max(2, fontSize)
}

function wrapLines(ctx, text, maxWidth) {
  const words = String(text || '').split(/\s+/)
  const lines = []
  let line = ''
  for (const word of words) {
    if (!word) continue
    const test = line ? `${line} ${word}` : word
    if (ctx.measureText(test).width <= maxWidth) {
      line = test
      continue
    }
    if (line) {
      lines.push(line)
      line = ''
    }
    if (ctx.measureText(word).width <= maxWidth) {
      line = word
      continue
    }
    let chunk = ''
    for (const ch of word) {
      const t2 = chunk + ch
      if (ctx.measureText(t2).width <= maxWidth) chunk = t2
      else {
        if (chunk) lines.push(chunk)
        chunk = ch
      }
    }
    line = chunk
  }
  if (line) lines.push(line)
  return lines.length ? lines : ['']
}

/**
 * Draw all text overlays on canvas (after grid).
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} w
 * @param {number} h
 * @param {TextOverlay[]} overlays
 * @param {number} elapsedSec
 */
export function drawTextOverlaysOnCanvas(ctx, w, h, overlays, elapsedSec) {
  if (!overlays?.length) return
  for (const o of overlays) {
    const nx = clamp(o.nx, 0, 0.98)
    const ny = clamp(o.ny, 0, 0.98)
    const nw = clamp(o.nw, 0.02, 1 - nx)
    const nh = clamp(o.nh, 0.02, 1 - ny)
    const x = nx * w
    const y = ny * h
    const boxW = nw * w
    const boxH = nh * h
    const baseFont = Math.max(8, (o.fontPx || 32) * (w / REF_WIDTH))
    const fontSize = fitFontSizeToBox(boxW, boxH, baseFont)
    const anim = textAnimationState(o.animation, elapsedSec, boxW, boxH)
    const textToDraw = applyTypingSlice(o.text, o.animation, elapsedSec)

    ctx.save()
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = anim.opacity
    ctx.fillStyle = /^#[0-9A-Fa-f]{6}$/i.test(o.color) ? o.color : '#ffffff'
    ctx.font = `600 ${fontSize}px system-ui, Segoe UI, sans-serif`
    ctx.textBaseline = 'top'

    const pad = Math.max(4, fontSize * 0.15)
    const maxLineW = Math.max(20, boxW - pad * 2)
    const lines = wrapLines(ctx, textToDraw, maxLineW)
    const lineHeight = fontSize * 1.25
    const minY = y + pad
    const maxYStart = y + boxH - lineHeight
    let ly = Math.max(minY, Math.min(y + pad + anim.offsetY, maxYStart))
    let lx = Math.max(x + pad, Math.min(x + pad + anim.offsetX, x + boxW - pad))

    ctx.beginPath()
    ctx.rect(x, y, boxW, boxH)
    ctx.clip()

    for (const line of lines) {
      if (ly + lineHeight > y + boxH) break
      ctx.fillText(line, lx, ly)
      ly += lineHeight
    }
    ctx.restore()
  }
}
