export function drawMediaCover(ctx, el, x, y, cw, ch) {
  let sw = 0
  let sh = 0
  if (el instanceof HTMLVideoElement) {
    sw = el.videoWidth
    sh = el.videoHeight
  } else {
    sw = el.naturalWidth
    sh = el.naturalHeight
  }
  if (!sw || !sh || !Number.isFinite(cw) || !Number.isFinite(ch) || cw <= 0 || ch <= 0) return
  const scale = Math.max(cw / sw, ch / sh)
  const dw = sw * scale
  const dh = sh * scale
  const dx = x + (cw - dw) / 2
  const dy = y + (ch - dh) / 2
  ctx.save()
  ctx.beginPath()
  ctx.rect(x, y, cw, ch)
  ctx.clip()
  ctx.drawImage(el, dx, dy, dw, dh)
  ctx.restore()
}

export function drawCompositionFrame({
  ctx,
  width,
  height,
  borderWidthPx,
  borderColor,
  drawCells,
  overlays,
  elapsedSec,
  drawTextOverlaysOnCanvas,
}) {
  if (borderWidthPx === 0) {
    ctx.fillStyle = '#000000'
    ctx.fillRect(0, 0, width, height)
  } else {
    ctx.fillStyle = borderColor
    ctx.fillRect(0, 0, width, height)
    ctx.fillStyle = '#000000'
    drawCells()
  }

  if (borderWidthPx === 0) {
    drawCells()
  }
  drawTextOverlaysOnCanvas(ctx, width, height, overlays, elapsedSec)
}
