export function createComposition({
  width,
  height,
  fps,
  rows,
  cols,
  border,
  cells,
  overlays,
  durationSec,
}) {
  return {
    width,
    height,
    fps,
    rows,
    cols,
    border,
    cells,
    overlays,
    durationSec,
    version: 1,
  }
}

export function createCellClip({
  cellIndex,
  sourceId,
  kind,
  trimStartSec = 0,
  trimEndSec = null,
}) {
  return {
    cellIndex,
    sourceId,
    kind,
    trimStartSec,
    trimEndSec,
  }
}
