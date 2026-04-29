import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import TextOverlayLayer from './TextOverlayLayer.jsx'
import { drawTextOverlaysOnCanvas, TEXT_ANIMATIONS } from './textOverlayUtils.js'
import { createCellClip, createComposition } from './core/compositionModel.js'
import { createNormalizedSource, probeImageMetadata, probeVideoMetadata } from './core/assetPipeline.js'
import { drawCompositionFrame, drawMediaCover } from './core/frameCompositor.js'
import { assertMp4ExportSupport, validateExportInput } from './core/export/webcodecsSupport.js'
import { ExportStageError } from './core/export/errors.js'
import { createDiagnostic } from './core/export/exportDiagnostics.js'
import { runMp4Export } from './core/export/exportEngine.js'
import { useExportController } from './hooks/useExportController.js'
import { useCompositionState } from './hooks/useCompositionState.js'

function gcdInt(a, b) {
  let x = Math.abs(Math.floor(a))
  let y = Math.abs(Math.floor(b))
  while (y) {
    const t = y
    y = x % y
    x = t
  }
  return x || 1
}

function aspectRatioLabel(w, h) {
  const wi = Math.max(1, Math.floor(Number(w)) || 0)
  const hi = Math.max(1, Math.floor(Number(h)) || 0)
  if (wi < 1 || hi < 1) return '—'
  const g = gcdInt(wi, hi)
  return `${wi / g}:${hi / g}`
}

const MAX_EXPORT_W = 7680
const MAX_EXPORT_H = 4320
const MIN_EXPORT_W = 320
const MIN_EXPORT_H = 240

/** Grouped canvas size presets (width × height px). */
const CANVAS_PRESET_GROUPS = [
  {
    title: 'Landscape — 16:9 (YouTube, TV)',
    items: [
      { label: '720p', w: 1280, h: 720 },
      { label: '1080p Full HD', w: 1920, h: 1080 },
      { label: '4K UHD', w: 3840, h: 2160 },
    ],
  },
  {
    title: 'Vertical — 9:16 (Reels, Stories, Shorts, TikTok)',
    items: [
      { label: '1080 × 1920 · Full HD', w: 1080, h: 1920 },
      { label: '720 × 1280', w: 720, h: 1280 },
      { label: '1440 × 2560', w: 1440, h: 2560 },
      { label: '4K vertical', w: 2160, h: 3840 },
    ],
  },
  {
    title: 'Instagram',
    items: [
      { label: 'Square feed · 1:1', w: 1080, h: 1080 },
      { label: 'Portrait feed · 4:5', w: 1080, h: 1350 },
      { label: 'Stories / Reels (full-bleed)', w: 1080, h: 1920 },
    ],
  },
  {
    title: 'More formats',
    items: [
      { label: 'LinkedIn / X card · ~1.91:1', w: 1200, h: 628 },
      { label: '3:4 portrait', w: 1080, h: 1440 },
      { label: 'Pinterest / 2:3', w: 1000, h: 1500 },
      { label: 'Ultrawide · 21:9', w: 2560, h: 1080 },
      { label: 'Classic 4:3', w: 1440, h: 1080 },
    ],
  },
]

function canvasPresetIdForDims(w, h) {
  const wi = Math.floor(Number(w)) || 0
  const hi = Math.floor(Number(h)) || 0
  for (let gi = 0; gi < CANVAS_PRESET_GROUPS.length; gi++) {
    const items = CANVAS_PRESET_GROUPS[gi].items
    for (let pi = 0; pi < items.length; pi++) {
      if (items[pi].w === wi && items[pi].h === hi) return `${gi}-${pi}`
    }
  }
  return ''
}

function resizeCellSources(prev, nextCount) {
  return Array.from({ length: nextCount }, (_, i) =>
    i < prev.length ? prev[i] : null,
  )
}

function loadVideoElement(src) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video')
    v.muted = true
    v.playsInline = true
    v.crossOrigin = 'anonymous'
    v.preload = 'auto'
    v.src = src
    v.addEventListener('loadeddata', () => resolve(v), { once: true })
    v.addEventListener('error', () => reject(new Error('video load failed')), { once: true })
  })
}

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image load failed'))
    img.src = src
  })
}

function seekVideoElement(video, nextTimeSec) {
  return new Promise((resolve) => {
    const onSeeked = () => {
      video.removeEventListener('seeked', onSeeked)
      resolve()
    }
    video.addEventListener('seeked', onSeeked)
    try {
      video.currentTime = Math.max(0, nextTimeSec)
    } catch {
      video.removeEventListener('seeked', onSeeked)
      resolve()
    }
  })
}

const MIN_CELL_FRAC = 0.02

/** Shift flex weight between adjacent indices i and i+1 (delta in same units as sum of sizes). */
function adjustAdjacentSizes(sizes, i, deltaFlex) {
  const next = [...sizes]
  const sum = next.reduce((a, b) => a + b, 0)
  if (sum <= 0 || i < 0 || i >= next.length - 1) return sizes
  const minV = sum * MIN_CELL_FRAC
  const pair = next[i] + next[i + 1]
  if (pair <= minV * 2) return sizes
  let a = next[i] + deltaFlex
  a = Math.max(minV, Math.min(pair - minV, a))
  next[i] = a
  next[i + 1] = pair - a
  return next
}

function normalizeWeightsToFractions(weights) {
  const positive = weights.map((x) => (Number.isFinite(x) && x > 0 ? x : 1))
  const s = positive.reduce((a, b) => a + b, 0)
  if (s <= 0) return positive.map(() => 1 / positive.length)
  return positive.map((x) => x / s)
}

function columnLayoutMetrics(canvasW, cols, borderPx, rawWeights) {
  const fr = normalizeWeightsToFractions(rawWeights)
  const B = borderPx
  const innerW = B === 0 ? canvasW : canvasW - B * (cols + 1)
  const widths = fr.map((w) => innerW * w)
  const xStarts = []
  let x = B === 0 ? 0 : B
  for (let c = 0; c < cols; c++) {
    xStarts[c] = x
    x += widths[c]
    if (c < cols - 1) x += B
  }
  return { widths, xStarts }
}

function rowLayoutMetrics(canvasH, rows, borderPx, rawWeights) {
  const fr = normalizeWeightsToFractions(rawWeights)
  const B = borderPx
  const innerH = B === 0 ? canvasH : canvasH - B * (rows + 1)
  const heights = fr.map((w) => innerH * w)
  const yStarts = []
  let y = B === 0 ? 0 : B
  for (let r = 0; r < rows; r++) {
    yStarts[r] = y
    y += heights[r]
    if (r < rows - 1) y += B
  }
  return { heights, yStarts }
}

/** Normalize flex weights allowing zeros; collapsed columns/rows get 0 share. */
function normalizeWeightsAllowZero(weights) {
  const w = weights.map((x) => (Number.isFinite(x) && x > 0 ? x : 0))
  const sum = w.reduce((a, b) => a + b, 0)
  if (sum <= 0) {
    const n = Math.max(1, weights.length)
    return Array(n).fill(1 / n)
  }
  return w.map((x) => x / sum)
}

/** Gutter before cell c: border after (c-1) only if that cell has width and something remains to the right. */
function showColGutterBefore(weights, c) {
  if (c <= 0) return false
  if (weights[c - 1] <= 0) return false
  for (let j = c; j < weights.length; j++) {
    if (weights[j] > 0) return true
  }
  return false
}

function showRowGutterBefore(weights, r) {
  return showColGutterBefore(weights, r)
}

/**
 * Column layout when some weights are 0 — only borders between consecutive visible cells.
 */
function columnLayoutMetricsAllowZero(canvasW, cols, borderPx, rawWeights) {
  const fr = normalizeWeightsAllowZero(rawWeights)
  const B = borderPx
  let internalBorders = 0
  for (let c = 0; c < cols - 1; c++) {
    if (fr[c] <= 0) continue
    for (let j = c + 1; j < cols; j++) {
      if (fr[j] > 0) {
        internalBorders++
        break
      }
    }
  }
  const innerW = B === 0 ? canvasW : canvasW - 2 * B - internalBorders * B
  const widths = fr.map((f) => innerW * f)
  const xStarts = []
  let x = B === 0 ? 0 : B
  for (let c = 0; c < cols; c++) {
    xStarts[c] = x
    x += widths[c]
    if (c < cols - 1) {
      let hasRight = false
      for (let j = c + 1; j < cols; j++) {
        if (fr[j] > 0) {
          hasRight = true
          break
        }
      }
      if (fr[c] > 0 && hasRight) x += B
    }
  }
  return { widths, xStarts }
}

function rowLayoutMetricsAllowZero(canvasH, rows, borderPx, rawWeights) {
  const fr = normalizeWeightsAllowZero(rawWeights)
  const B = borderPx
  let internalBorders = 0
  for (let r = 0; r < rows - 1; r++) {
    if (fr[r] <= 0) continue
    for (let j = r + 1; j < rows; j++) {
      if (fr[j] > 0) {
        internalBorders++
        break
      }
    }
  }
  const innerH = B === 0 ? canvasH : canvasH - 2 * B - internalBorders * B
  const heights = fr.map((f) => innerH * f)
  const yStarts = []
  let y = B === 0 ? 0 : B
  for (let r = 0; r < rows; r++) {
    yStarts[r] = y
    y += heights[r]
    if (r < rows - 1) {
      let hasBelow = false
      for (let j = r + 1; j < rows; j++) {
        if (fr[j] > 0) {
          hasBelow = true
          break
        }
      }
      if (fr[r] > 0 && hasBelow) y += B
    }
  }
  return { heights, yStarts }
}

function collapseCellInLineWeights(line, index) {
  const next = [...line]
  const positives = next.map((x, i) => (x > 0 ? i : -1)).filter((i) => i >= 0)
  if (positives.length <= 1) return line
  if (next[index] <= 0) return line
  const removed = next[index]
  next[index] = 0
  const others = positives.filter((i) => i !== index)
  const share = removed / others.length
  for (const i of others) next[i] += share
  return next
}

function restoreCellInLineWeights(line, index) {
  if (line[index] > 0) return line
  const next = [...line]
  next[index] = 1
  const s = next.reduce((a, b) => a + b, 0)
  if (s <= 0) return line
  return next.map((x) => x / s)
}

export default function App() {
  const [rows, setRows] = useState(2)
  const [cols, setCols] = useState(2)
  const [draftRows, setDraftRows] = useState(2)
  const [draftCols, setDraftCols] = useState(2)
  const [cellSources, setCellSources] = useState(() => Array(4).fill(null))
  const [exportWidth, setExportWidth] = useState(1280)
  const [exportHeight, setExportHeight] = useState(720)
  const [fps, setFps] = useState(30)
  const [stillDurationSec, setStillDurationSec] = useState(5)
  const [borderWidthPx, setBorderWidthPx] = useState(6)
  const [borderColor, setBorderColor] = useState('#ffffff')
  const [colSizes, setColSizes] = useState(() => [1, 1])
  const [rowSizes, setRowSizes] = useState(() => [1, 1])
  /** When enabled, either column widths vary per row or row heights vary per column (see splitMode). */
  const [independentSplits, setIndependentSplits] = useState(false)
  const [splitMode, setSplitMode] = useState(() => 'perRowCols')
  /** [row][col] flex weights — only used when independentSplits && splitMode === 'perRowCols' */
  const [colSizesByRow, setColSizesByRow] = useState(() => [
    [1, 1],
    [1, 1],
  ])
  /** [col][row] flex weights — only used when independentSplits && splitMode === 'perColRows' */
  const [rowSizesByCol, setRowSizesByCol] = useState(() => [
    [1, 1],
    [1, 1],
  ])
  const colStackRefs = useRef([])
  const colSizesByRowRef = useRef(colSizesByRow)
  const rowSizesByColRef = useRef(rowSizesByCol)
  const {
    exporting,
    exportProgress,
    statusMessage,
    setExporting,
    setExportProgress,
    setStatusMessage,
  } = useExportController()
  const { textOverlays, setTextOverlays, selectedTextId, setSelectedTextId } =
    useCompositionState()
  /** Latest overlays for export frames (runExport awaits loading; closure textOverlays can be stale). */
  const textOverlaysRef = useRef(textOverlays)

  const canvasRef = useRef(null)
  const cellSourcesRef = useRef(cellSources)
  const previewHostRef = useRef(null)
  const previewAspectInnerRef = useRef(null)
  const gridFlexStackRef = useRef(null)

  const cellCount = rows * cols

  useEffect(() => {
    cellSourcesRef.current = cellSources
  }, [cellSources])

  useEffect(() => {
    colSizesByRowRef.current = colSizesByRow
  }, [colSizesByRow])

  useEffect(() => {
    rowSizesByColRef.current = rowSizesByCol
  }, [rowSizesByCol])

  useEffect(() => {
    textOverlaysRef.current = textOverlays
  }, [textOverlays])

  useEffect(() => {
    return () => {
      cellSourcesRef.current.forEach((cell) => {
        if (cell?.src) URL.revokeObjectURL(cell.src)
      })
    }
  }, [])

  const applyGrid = useCallback(() => {
    const r = Math.min(12, Math.max(1, Math.floor(Number(draftRows)) || 1))
    const c = Math.min(12, Math.max(1, Math.floor(Number(draftCols)) || 1))
    setDraftRows(r)
    setDraftCols(c)
    setRows(r)
    setCols(c)
    setColSizes(Array(c).fill(1))
    setRowSizes(Array(r).fill(1))
    setColSizesByRow(Array.from({ length: r }, () => Array(c).fill(1)))
    setRowSizesByCol(Array.from({ length: c }, () => Array(r).fill(1)))
    setCellSources((prev) => {
      const next = resizeCellSources(prev, r * c)
      for (let i = next.length; i < prev.length; i++) {
        if (prev[i]?.src) URL.revokeObjectURL(prev[i].src)
      }
      return next
    })
  }, [draftRows, draftCols])

  const onPickFile = useCallback((index, file) => {
    if (!file) return
    const isVideo = file.type.startsWith('video/')
    const isImage = file.type.startsWith('image/')
    if (!isVideo && !isImage) {
      setStatusMessage('Please choose an image or video file.')
      return
    }
    setCellSources((prev) => {
      const next = [...prev]
      if (next[index]?.src) URL.revokeObjectURL(next[index].src)
      next[index] = {
        kind: isVideo ? 'video' : 'image',
        src: URL.createObjectURL(file),
      }
      return next
    })
    setStatusMessage('')
  }, [setStatusMessage])

  const clearCell = useCallback((index) => {
    setCellSources((prev) => {
      const next = [...prev]
      if (next[index]?.src) URL.revokeObjectURL(next[index].src)
      next[index] = null
      return next
    })
  }, [])

  const newTextId = useCallback(
    () => `t-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    [],
  )

  const addTextOverlay = useCallback(
    (partial) => {
      const id = newTextId()
      setTextOverlays((prev) => [
        ...prev,
        {
          id,
          text: 'Your text',
          nx: 0.1,
          ny: 0.1,
          nw: 0.45,
          nh: 0.14,
          color: '#ffffff',
          fontPx: 48,
          animation: 'none',
          ...partial,
        },
      ])
      setSelectedTextId(id)
    },
    [newTextId, setSelectedTextId, setTextOverlays],
  )

  const createTextAtNormalized = useCallback(
    (nx, ny) => {
      const w = 0.32
      const h = 0.12
      addTextOverlay({
        text: 'Your text',
        nx: Math.max(0, Math.min(1 - w, nx - w / 2)),
        ny: Math.max(0, Math.min(1 - h, ny - h / 2)),
        nw: w,
        nh: h,
      })
    },
    [addTextOverlay],
  )

  const startColDrag = useCallback(
    (colIndex, e, rowIndexForPerRow = null) => {
      e.preventDefault()
      e.stopPropagation()
      const last = { x: e.clientX }
      const onMove = (ev) => {
        const dx = ev.clientX - last.x
        last.x = ev.clientX
        const stack = gridFlexStackRef.current
        const w =
          stack?.getBoundingClientRect().width ||
          previewHostRef.current?.getBoundingClientRect().width ||
          1
        const perRow =
          independentSplits && splitMode === 'perRowCols' && rowIndexForPerRow != null
        if (perRow) {
          const ri = rowIndexForPerRow
          setColSizesByRow((prev) => {
            if (ri < 0 || ri >= prev.length) return prev
            const row = prev[ri]
            if (colIndex < 0 || colIndex >= row.length - 1) return prev
            const sum = row.reduce((a, b) => a + b, 0)
            const deltaFlex = (dx / Math.max(w, 1)) * sum
            const adjusted = adjustAdjacentSizes(row, colIndex, deltaFlex)
            if (adjusted === row) return prev
            const next = [...prev]
            next[ri] = adjusted
            return next
          })
        } else {
          setColSizes((prev) => {
            if (colIndex < 0 || colIndex >= prev.length - 1) return prev
            const sum = prev.reduce((a, b) => a + b, 0)
            const deltaFlex = (dx / Math.max(w, 1)) * sum
            return adjustAdjacentSizes(prev, colIndex, deltaFlex)
          })
        }
      }
      const onUp = () => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [independentSplits, splitMode],
  )

  const startRowDrag = useCallback(
    (rowIndex, e, colIndexForPerCol = null) => {
      e.preventDefault()
      e.stopPropagation()
      const last = { y: e.clientY }
      const onMove = (ev) => {
        const dy = ev.clientY - last.y
        last.y = ev.clientY
        const perCol =
          independentSplits && splitMode === 'perColRows' && colIndexForPerCol != null
        const stack = gridFlexStackRef.current
        const h = perCol
          ? colStackRefs.current[colIndexForPerCol]?.getBoundingClientRect().height ||
            stack?.getBoundingClientRect().height ||
            previewHostRef.current?.getBoundingClientRect().height ||
            1
          : stack?.getBoundingClientRect().height ||
            previewHostRef.current?.getBoundingClientRect().height ||
            1
        if (perCol) {
          const ci = colIndexForPerCol
          setRowSizesByCol((prev) => {
            if (ci < 0 || ci >= prev.length) return prev
            const col = prev[ci]
            if (rowIndex < 0 || rowIndex >= col.length - 1) return prev
            const sum = col.reduce((a, b) => a + b, 0)
            const deltaFlex = (dy / Math.max(h, 1)) * sum
            const adjusted = adjustAdjacentSizes(col, rowIndex, deltaFlex)
            if (adjusted === col) return prev
            const next = [...prev]
            next[ci] = adjusted
            return next
          })
        } else {
          setRowSizes((prev) => {
            if (rowIndex < 0 || rowIndex >= prev.length - 1) return prev
            const sum = prev.reduce((a, b) => a + b, 0)
            const deltaFlex = (dy / Math.max(h, 1)) * sum
            return adjustAdjacentSizes(prev, rowIndex, deltaFlex)
          })
        }
      }
      const onUp = () => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [independentSplits, splitMode],
  )

  const collapseCellRow = useCallback((r, c) => {
    setColSizesByRow((prev) => {
      const row = prev[r]
      if (!row) return prev
      const nextRow = collapseCellInLineWeights(row, c)
      if (nextRow === row) return prev
      const copy = [...prev]
      copy[r] = nextRow
      return copy
    })
  }, [])

  const restoreCellRow = useCallback((r, c) => {
    setColSizesByRow((prev) => {
      const row = prev[r]
      if (!row) return prev
      const nextRow = restoreCellInLineWeights(row, c)
      if (nextRow === row) return prev
      const copy = [...prev]
      copy[r] = nextRow
      return copy
    })
  }, [])

  const collapseCellCol = useCallback((c, r) => {
    setRowSizesByCol((prev) => {
      const col = prev[c]
      if (!col) return prev
      const nextCol = collapseCellInLineWeights(col, r)
      if (nextCol === col) return prev
      const copy = [...prev]
      copy[c] = nextCol
      return copy
    })
  }, [])

  const restoreCellCol = useCallback((c, r) => {
    setRowSizesByCol((prev) => {
      const col = prev[c]
      if (!col) return prev
      const nextCol = restoreCellInLineWeights(col, r)
      if (nextCol === col) return prev
      const copy = [...prev]
      copy[c] = nextCol
      return copy
    })
  }, [])

  const canvasSizeMeta = useMemo(() => {
    const wi = Math.max(0, Math.floor(Number(exportWidth)) || 0)
    const hi = Math.max(0, Math.floor(Number(exportHeight)) || 0)
    const mp = wi > 0 && hi > 0 ? ((wi * hi) / 1e6).toFixed(2) : null
    return {
      ar: aspectRatioLabel(exportWidth, exportHeight),
      mp,
      wi,
      hi,
    }
  }, [exportHeight, exportWidth])

  const canvasPresetSelectValue = useMemo(
    () => canvasPresetIdForDims(exportWidth, exportHeight),
    [exportHeight, exportWidth],
  )

  const selectedTextOverlay = useMemo(
    () => textOverlays.find((t) => t.id === selectedTextId),
    [selectedTextId, textOverlays],
  )

  const applyCanvasPreset = useCallback((pw, ph) => {
    setExportWidth(pw)
    setExportHeight(ph)
  }, [])

  const scaleCanvasSize = useCallback((factor) => {
    setExportWidth((prev) =>
      Math.min(
        MAX_EXPORT_W,
        Math.max(MIN_EXPORT_W, Math.round((Number(prev) || 1280) * factor)),
      ),
    )
    setExportHeight((prev) =>
      Math.min(
        MAX_EXPORT_H,
        Math.max(MIN_EXPORT_H, Math.round((Number(prev) || 720) * factor)),
      ),
    )
  }, [])

  const handleIndependentSplitsChange = useCallback(
    (checked) => {
      if (checked) {
        setColSizesByRow(Array.from({ length: rows }, () => [...colSizes]))
        setRowSizesByCol(Array.from({ length: cols }, () => [...rowSizes]))
        setIndependentSplits(true)
      } else {
        if (splitMode === 'perRowCols') {
          const row0 = colSizesByRowRef.current[0]
          if (row0 && row0.length === cols) setColSizes([...row0])
        } else {
          const col0 = rowSizesByColRef.current[0]
          if (col0 && col0.length === rows) setRowSizes([...col0])
        }
        setIndependentSplits(false)
      }
    },
    [colSizes, cols, rowSizes, rows, splitMode],
  )

  const handleSplitModeChange = useCallback(
    (next) => {
      setSplitMode(next)
      if (!independentSplits) return
      if (next === 'perRowCols') {
        setColSizesByRow(Array.from({ length: rows }, () => [...colSizes]))
      } else {
        setRowSizesByCol(Array.from({ length: cols }, () => [...rowSizes]))
      }
    },
    [colSizes, cols, independentSplits, rowSizes, rows],
  )

  const runExport = useCallback(async () => {
    const diagnostics = []
    const setStageStatus = (stage, message, extra = {}) => {
      const d = createDiagnostic({ stage, message, ...extra })
      diagnostics.push(d)
      setStatusMessage(`[${stage}] ${message}`)
    }

    const filled = cellSources
      .map((cell, i) => (cell ? { ...cell, index: i } : null))
      .filter(Boolean)

    if (filled.length === 0) {
      setStatusMessage('Add at least one photo or video to a cell before exporting.')
      return
    }

    const canvas = canvasRef.current
    if (!canvas) return

    const w = Math.min(MAX_EXPORT_W, Math.max(MIN_EXPORT_W, Math.floor(exportWidth)))
    const h = Math.min(MAX_EXPORT_H, Math.max(MIN_EXPORT_H, Math.floor(exportHeight)))

    try {
      validateExportInput({ width: w, height: h, fps })
      await assertMp4ExportSupport({ width: w, height: h, fps })
    } catch (error) {
      const stageError = new ExportStageError(
        'preflight',
        error?.message || 'MP4 export is not supported for this configuration.',
        error,
      )
      setStageStatus(stageError.stage, stageError.message)
      return
    }

    setExporting(true)
    setExportProgress(0)
    setStatusMessage('Preparing…')

    canvas.width = w
    canvas.height = h

    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) {
      setStageStatus('render-init', 'Could not get canvas context.')
      setExporting(false)
      return
    }

    const B = Math.min(120, Math.max(0, Math.floor(Number(borderWidthPx)) || 0))
    const bc = /^#[0-9A-Fa-f]{6}$/.test(borderColor) ? borderColor : '#ffffff'
    const minW = B * (cols + 1)
    const minH = B * (rows + 1)
    if (B > 0 && (w < minW || h < minH)) {
      setStageStatus(
        'preflight',
        `Border is too thick for this resolution (${w}×${h}). Reduce border width or size.`,
      )
      setExporting(false)
      return
    }

    const perRowCols = independentSplits && splitMode === 'perRowCols'
    const perColRows = independentSplits && splitMode === 'perColRows'

    const stillSec = Math.min(600, Math.max(1, Math.floor(Number(stillDurationSec)) || 5))

    let mediaByIndex = {}
    try {
      const loaded = await Promise.all(
        filled.map((item) => {
          if (item.kind === 'video') {
            return loadVideoElement(item.src).then((el) => ({
              index: item.index,
              kind: 'video',
              el,
            }))
          }
          return loadImageElement(item.src).then((el) => ({
            index: item.index,
            kind: 'image',
            el,
          }))
        }),
      )
      mediaByIndex = Object.fromEntries(loaded.map((m) => [m.index, m]))
    } catch {
      setStageStatus('asset-load', 'Failed to load one or more files.')
      setExporting(false)
      return
    }

    const metadataByIndex = {}
    try {
      const metadataEntries = await Promise.all(
        filled.map(async (item) => {
          const meta =
            item.kind === 'video'
              ? await probeVideoMetadata(item.src)
              : await probeImageMetadata(item.src)
          return [item.index, createNormalizedSource({ id: `cell-${item.index}`, kind: item.kind, src: item.src, meta })]
        }),
      )
      for (const [idx, source] of metadataEntries) {
        metadataByIndex[idx] = source
      }
    } catch {
      setStageStatus('asset-probe', 'Failed to read metadata from one or more files.')
      setExporting(false)
      return
    }

    let maxVideoSec = 0
    for (const item of filled) {
      if (item.kind !== 'video') continue
      const d = metadataByIndex[item.index]?.meta?.durationSec
      if (Number.isFinite(d) && d > 0) maxVideoSec = Math.max(maxVideoSec, d)
    }

    const hasVideo = filled.some((x) => x.kind === 'video')
    if (hasVideo && maxVideoSec <= 0) {
      setStageStatus('duration', 'Could not read duration for one or more videos.')
      for (const item of filled) {
        if (item.kind === 'video') {
          const el = mediaByIndex[item.index]?.el
          if (el) el.src = ''
        }
      }
      setExporting(false)
      return
    }

    const durationSec = hasVideo ? maxVideoSec : stillSec
    const normalizedCells = filled.map((item) =>
      createCellClip({
        cellIndex: item.index,
        sourceId: `cell-${item.index}`,
        kind: item.kind,
      }),
    )
    const composition = createComposition({
      width: w,
      height: h,
      fps,
      rows,
      cols,
      border: { widthPx: B, color: bc },
      cells: normalizedCells,
      overlays: textOverlaysRef.current,
      durationSec,
    })
    const videoEntries = filled
      .filter((x) => x.kind === 'video')
      .map((x) => ({ index: x.index, el: mediaByIndex[x.index].el }))

    try {
      const blob = await runMp4Export({
        composition,
        canvas,
        onProgress: setExportProgress,
        drawFrame: async (elapsedSec) => {
          await Promise.all(
            videoEntries.map(async ({ el, index }) => {
              const srcDuration = metadataByIndex[index]?.meta?.durationSec || 0
              const seekTo = srcDuration > 0 ? Math.min(elapsedSec, Math.max(0, srcDuration - 0.001)) : elapsedSec
              await seekVideoElement(el, seekTo)
            }),
          )

          drawCompositionFrame({
            ctx,
            width: w,
            height: h,
            borderWidthPx: B,
            borderColor: bc,
            overlays: textOverlaysRef.current,
            elapsedSec,
            drawTextOverlaysOnCanvas,
            drawCells: () => {
              if (perRowCols) {
                const { heights: rowHeights, yStarts: rowY } = rowLayoutMetrics(h, rows, B, rowSizes)
                for (let r = 0; r < rows; r++) {
                  const { widths: colWidths, xStarts: colX } = columnLayoutMetricsAllowZero(
                    w,
                    cols,
                    B,
                    colSizesByRow[r],
                  )
                  for (let c = 0; c < cols; c++) {
                    ctx.fillRect(colX[c], rowY[r], colWidths[c], rowHeights[r])
                  }
                }
              } else if (perColRows) {
                const { widths: colWidths, xStarts: colX } = columnLayoutMetrics(w, cols, B, colSizes)
                for (let c = 0; c < cols; c++) {
                  const { heights: rowHeights, yStarts: rowY } = rowLayoutMetricsAllowZero(
                    h,
                    rows,
                    B,
                    rowSizesByCol[c],
                  )
                  for (let r = 0; r < rows; r++) {
                    ctx.fillRect(colX[c], rowY[r], colWidths[c], rowHeights[r])
                  }
                }
              } else {
                const { widths: colWidths, xStarts: colX } = columnLayoutMetrics(w, cols, B, colSizes)
                const { heights: rowHeights, yStarts: rowY } = rowLayoutMetrics(h, rows, B, rowSizes)
                for (let r = 0; r < rows; r++) {
                  for (let c = 0; c < cols; c++) {
                    ctx.fillRect(colX[c], rowY[r], colWidths[c], rowHeights[r])
                  }
                }
              }

              if (perRowCols) {
                const { heights: rowHeights, yStarts: rowY } = rowLayoutMetrics(h, rows, B, rowSizes)
                for (let r = 0; r < rows; r++) {
                  const { widths: colWidths, xStarts: colX } = columnLayoutMetricsAllowZero(
                    w,
                    cols,
                    B,
                    colSizesByRow[r],
                  )
                  for (let c = 0; c < cols; c++) {
                    const idx = r * cols + c
                    const m = mediaByIndex[idx]
                    if (!m) continue
                    const x = colX[c]
                    const y = rowY[r]
                    const cw = colWidths[c]
                    const ch = rowHeights[r]
                    if (cw <= 0 || ch <= 0) continue
                    try {
                      if (m.kind === 'video' && m.el.readyState >= 2) {
                        drawMediaCover(ctx, m.el, x, y, cw, ch)
                      } else if (m.kind === 'image' && m.el.complete && m.el.naturalWidth) {
                        drawMediaCover(ctx, m.el, x, y, cw, ch)
                      }
                    } catch {
                      /* ignore */
                    }
                  }
                }
              } else if (perColRows) {
                const { widths: colWidths, xStarts: colX } = columnLayoutMetrics(w, cols, B, colSizes)
                for (let c = 0; c < cols; c++) {
                  const { heights: rowHeights, yStarts: rowY } = rowLayoutMetricsAllowZero(
                    h,
                    rows,
                    B,
                    rowSizesByCol[c],
                  )
                  for (let r = 0; r < rows; r++) {
                    const idx = r * cols + c
                    const m = mediaByIndex[idx]
                    if (!m) continue
                    const x = colX[c]
                    const y = rowY[r]
                    const cw = colWidths[c]
                    const ch = rowHeights[r]
                    if (cw <= 0 || ch <= 0) continue
                    try {
                      if (m.kind === 'video' && m.el.readyState >= 2) {
                        drawMediaCover(ctx, m.el, x, y, cw, ch)
                      } else if (m.kind === 'image' && m.el.complete && m.el.naturalWidth) {
                        drawMediaCover(ctx, m.el, x, y, cw, ch)
                      }
                    } catch {
                      /* ignore */
                    }
                  }
                }
              } else {
                const { widths: colWidths, xStarts: colX } = columnLayoutMetrics(w, cols, B, colSizes)
                const { heights: rowHeights, yStarts: rowY } = rowLayoutMetrics(h, rows, B, rowSizes)
                for (let r = 0; r < rows; r++) {
                  for (let c = 0; c < cols; c++) {
                    const idx = r * cols + c
                    const m = mediaByIndex[idx]
                    if (!m) continue
                    const x = colX[c]
                    const y = rowY[r]
                    const cw = colWidths[c]
                    const ch = rowHeights[r]
                    try {
                      if (m.kind === 'video' && m.el.readyState >= 2) {
                        drawMediaCover(ctx, m.el, x, y, cw, ch)
                      } else if (m.kind === 'image' && m.el.complete && m.el.naturalWidth) {
                        drawMediaCover(ctx, m.el, x, y, cw, ch)
                      }
                    } catch {
                      /* ignore */
                    }
                  }
                }
              }
            },
          })
        },
      })

      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `collage-${rows}x${cols}-${w}x${h}-${Date.now()}.mp4`
      a.click()
      URL.revokeObjectURL(url)
      setExportProgress(100)
      setStatusMessage('Export finished. Download should start automatically.')
    } catch (error) {
      const stage = error?.stage || 'export'
      setStageStatus(stage, error?.message || 'MP4 export failed.')
    } finally {
      videoEntries.forEach(({ el }) => {
        el.pause()
        el.src = ''
      })
      setExporting(false)
    }
  }, [
    borderColor,
    borderWidthPx,
    cellSources,
    colSizes,
    colSizesByRow,
    cols,
    exportHeight,
    exportWidth,
    fps,
    independentSplits,
    rowSizes,
    rowSizesByCol,
    rows,
    splitMode,
    stillDurationSec,
    setExportProgress,
    setExporting,
    setStatusMessage,
  ])

  function renderGridCell(r, c, flex, cellOpts) {
    const index = r * cols + c
    const {
      collapsed = false,
      rowCollapse = false,
      colCollapse = false,
      canCollapse = false,
      onCollapse,
      onRestore,
    } = cellOpts || {}
    const cellStyle = collapsed
      ? rowCollapse
        ? { flex: '0 0 52px', minWidth: 52, maxWidth: 52, minHeight: 0, overflow: 'hidden' }
        : colCollapse
          ? { flex: '0 0 52px', minHeight: 52, maxHeight: 52, minWidth: 0, overflow: 'hidden' }
          : { flex, minWidth: 0, minHeight: 0 }
      : { flex, minWidth: 0, minHeight: 0 }

    return (
      <div
        className={`cell ${collapsed ? 'cell--collapsed' : ''}`.trim()}
        style={cellStyle}
      >
        <div className="cell-head">
          <span className="cell-label">
            {r + 1},{c + 1}
          </span>
          <div className="cell-head-actions">
            {(rowCollapse || colCollapse) && onCollapse ? (
              collapsed ? (
                <button type="button" className="btn tiny" onClick={() => onRestore?.()}>
                  Restore
                </button>
              ) : canCollapse ? (
                <button type="button" className="btn tiny" onClick={() => onCollapse()}>
                  Remove
                </button>
              ) : null
            ) : null}
            {cellSources[index] ? (
              <button type="button" className="btn tiny" onClick={() => clearCell(index)}>
                Clear
              </button>
            ) : null}
          </div>
        </div>
        {collapsed ? (
          <p className="cell-collapsed-hint">Hidden in export — Restore to show again.</p>
        ) : cellSources[index] ? (
          cellSources[index].kind === 'image' ? (
            <img className="cell-image" src={cellSources[index].src} alt="" />
          ) : (
            <video
              className="cell-video"
              src={cellSources[index].src}
              muted
              playsInline
              loop
              controls
            />
          )
        ) : (
          <label className="drop">
            <input
              type="file"
              accept="image/*,video/*"
              className="sr"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) onPickFile(index, f)
                e.target.value = ''
              }}
            />
            <span>Add photo or video</span>
          </label>
        )}
      </div>
    )
  }

  const useRowMajor = !independentSplits || splitMode === 'perRowCols'

  return (
    <div className="app">
      <header className="header">
        <h1>Open Collage</h1>
        <p className="lede">
          Set a grid and add a photo or video per cell, then export a single MP4 collage. Length
          follows the longest video; photo-only grids use the duration you set below.
        </p>
      </header>

      <div className="app-workspace">
        <div className="app-settings">
      <section className="panel">
        <h2>Grid</h2>
        <div className="row">
          <label className="field">
            <span>Rows</span>
            <input
              type="number"
              min={1}
              max={12}
              value={draftRows}
              onChange={(e) => setDraftRows(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Columns</span>
            <input
              type="number"
              min={1}
              max={12}
              value={draftCols}
              onChange={(e) => setDraftCols(e.target.value)}
            />
          </label>
          <button type="button" className="btn primary" onClick={applyGrid}>
            Apply grid
          </button>
        </div>
        <p className="hint">Current layout: {rows}×{cols} ({cellCount} cells).</p>
        <h3 className="export-subhead">Cell sizes</h3>
        <p className="hint">
          In the preview on the right, drag the bars between cells to resize. Export uses the same
          proportions.
        </p>
        <label className="field field-checkbox">
          <input
            type="checkbox"
            checked={independentSplits}
            onChange={(e) => handleIndependentSplitsChange(e.target.checked)}
          />
          <span>Independent splits</span>
        </label>
        {independentSplits ? (
          <div className="split-mode-radios" role="radiogroup" aria-label="Independent split mode">
            <label className="field field-radio">
              <input
                type="radio"
                name="splitMode"
                checked={splitMode === 'perRowCols'}
                onChange={() => handleSplitModeChange('perRowCols')}
              />
              <span>Column widths vary per row</span>
            </label>
            <label className="field field-radio">
              <input
                type="radio"
                name="splitMode"
                checked={splitMode === 'perColRows'}
                onChange={() => handleSplitModeChange('perColRows')}
              />
              <span>Row heights vary per column</span>
            </label>
            <p className="hint split-mode-hint">
              {splitMode === 'perRowCols'
                ? 'Vertical drag handles only affect that row. Horizontal splitters still change the whole grid. Use Remove on a cell to give the rest of that row full width; Restore brings it back.'
                : 'Horizontal drag handles only affect that column. Vertical splitters still change the whole grid. Use Remove on a cell to give the rest of that column full height; Restore brings it back.'}
            </p>
          </div>
        ) : null}
        <div className="row wrap">
          <button
            type="button"
            className="btn ghost"
            onClick={() => {
              if (independentSplits) {
                if (splitMode === 'perRowCols') {
                  setColSizesByRow(Array.from({ length: rows }, () => Array(cols).fill(1)))
                  setRowSizes(Array(rows).fill(1))
                } else {
                  setRowSizesByCol(Array.from({ length: cols }, () => Array(rows).fill(1)))
                  setColSizes(Array(cols).fill(1))
                }
              } else {
                setColSizes(Array(cols).fill(1))
                setRowSizes(Array(rows).fill(1))
              }
            }}
          >
            Equal cells
          </button>
        </div>
      </section>

      <section className="panel">
        <h2>Borders</h2>
        <div className="row wrap">
          <label className="field">
            <span>Width (px)</span>
            <input
              type="number"
              min={0}
              max={120}
              value={borderWidthPx}
              onChange={(e) => setBorderWidthPx(e.target.value)}
            />
          </label>
          <label className="field field-color">
            <span>Color</span>
            <input
              type="color"
              value={/^#[0-9A-Fa-f]{6}$/.test(borderColor) ? borderColor : '#ffffff'}
              onChange={(e) => setBorderColor(e.target.value)}
            />
          </label>
          <label className="field field-hex">
            <span>Hex</span>
            <input
              type="text"
              maxLength={7}
              placeholder="#ffffff"
              value={borderColor}
              onChange={(e) => setBorderColor(e.target.value)}
            />
          </label>
        </div>
        <p className="hint">
          Same thickness for outer frame and lines between cells. Set to 0 for no borders. Export
          needs enough pixels: width and height must exceed (columns + 1) × border and (rows + 1) ×
          border.
        </p>
      </section>

      <section className="panel">
        <h2>Text overlays</h2>
        <p className="hint">
          Double-click empty space on the preview to place text. Drag the box to move, drag the
          corner to resize. Export bakes text and animation into the video.
        </p>
        <div className="row wrap">
          <button
            type="button"
            className="btn primary"
            onClick={() => addTextOverlay({ nx: 0.08, ny: 0.08, nw: 0.5, nh: 0.14 })}
          >
            Add text
          </button>
        </div>
        {selectedTextOverlay ? (
          <div className="text-overlay-editor">
            <label className="field">
              <span>Content</span>
              <textarea
                rows={3}
                value={selectedTextOverlay.text}
                onChange={(e) => {
                  const v = e.target.value
                  setTextOverlays((prev) =>
                    prev.map((t) => (t.id === selectedTextOverlay.id ? { ...t, text: v } : t)),
                  )
                }}
              />
            </label>
            <div className="row wrap">
              <label className="field field-color">
                <span>Color</span>
                <input
                  type="color"
                  value={
                    /^#[0-9A-Fa-f]{6}$/i.test(selectedTextOverlay.color)
                      ? selectedTextOverlay.color
                      : '#ffffff'
                  }
                  onChange={(e) => {
                    const v = e.target.value
                    setTextOverlays((prev) =>
                      prev.map((t) => (t.id === selectedTextOverlay.id ? { ...t, color: v } : t)),
                    )
                  }}
                />
              </label>
              <label className="field">
                <span>Font size (export)</span>
                <input
                  type="number"
                  min={12}
                  max={400}
                  value={selectedTextOverlay.fontPx}
                  onChange={(e) => {
                    const n = Math.min(400, Math.max(12, Math.floor(Number(e.target.value)) || 32))
                    setTextOverlays((prev) =>
                      prev.map((t) => (t.id === selectedTextOverlay.id ? { ...t, fontPx: n } : t)),
                    )
                  }}
                />
              </label>
              <label className="field">
                <span>Animation</span>
                <select
                  value={selectedTextOverlay.animation}
                  onChange={(e) => {
                    const v = e.target.value
                    setTextOverlays((prev) =>
                      prev.map((t) => (t.id === selectedTextOverlay.id ? { ...t, animation: v } : t)),
                    )
                  }}
                >
                  {TEXT_ANIMATIONS.map((a) => (
                    <option key={a.value} value={a.value}>
                      {a.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                setTextOverlays((prev) => prev.filter((t) => t.id !== selectedTextOverlay.id))
                setSelectedTextId(null)
              }}
            >
              Remove this text
            </button>
          </div>
        ) : (
          <p className="hint">Select a text box on the preview to edit, or add one.</p>
        )}
      </section>

      <section className="panel">
        <h2>Canvas</h2>
        <h3 className="export-subhead">Size (matches export)</h3>
        <p className="dim-meta cells-dim-meta">
          Aspect ratio <strong>{canvasSizeMeta.ar}</strong>
          {canvasSizeMeta.wi > 0 && canvasSizeMeta.hi > 0 ? (
            <>
              {' · '}
              <strong>
                {canvasSizeMeta.wi} × {canvasSizeMeta.hi}
              </strong>
              {' px'}
              {canvasSizeMeta.mp != null ? <> · ~{canvasSizeMeta.mp} MP</> : null}
            </>
          ) : null}
        </p>
        <label className="field field-preset-select field-preset-select--cells">
          <span>Preset size</span>
          <select
            className="preset-select"
            value={canvasPresetSelectValue}
            onChange={(e) => {
              const v = e.target.value
              if (!v) return
              const [gi, pi] = v.split('-').map(Number)
              const p = CANVAS_PRESET_GROUPS[gi]?.items[pi]
              if (p) applyCanvasPreset(p.w, p.h)
            }}
          >
            <option value="">Custom (edit width & height under Export)</option>
            {CANVAS_PRESET_GROUPS.map((group, gi) => (
              <optgroup key={group.title} label={group.title}>
                {group.items.map((p, pi) => (
                  <option key={`${gi}-${pi}`} value={`${gi}-${pi}`}>
                    {p.label} — {p.w}×{p.h}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
      </section>

      <section className="panel">
        <h2>Export</h2>
        <p className="hint export-canvas-hint">
          Preview uses the width and height here — change preset or pixels to match your delivery
          size.
        </p>
        <div className="row wrap">
          <label className="field">
            <span>Width (px)</span>
            <input
              type="number"
              min={MIN_EXPORT_W}
              max={MAX_EXPORT_W}
              value={exportWidth}
              onChange={(e) => setExportWidth(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Height (px)</span>
            <input
              type="number"
              min={MIN_EXPORT_H}
              max={MAX_EXPORT_H}
              value={exportHeight}
              onChange={(e) => setExportHeight(e.target.value)}
            />
          </label>
          <label className="field">
            <span>FPS</span>
            <select value={fps} onChange={(e) => setFps(Number(e.target.value))}>
              <option value={15}>15</option>
              <option value={24}>24</option>
              <option value={30}>30</option>
              <option value={60}>60</option>
            </select>
          </label>
          <label className="field">
            <span>Seconds (photos only)</span>
            <input
              type="number"
              min={1}
              max={600}
              value={stillDurationSec}
              onChange={(e) => setStillDurationSec(e.target.value)}
              title="Used when the grid has no videos — only photos"
            />
          </label>
        </div>
        <div className="row wrap scale-row">
          <span className="scale-label">Resize (keep ratio)</span>
          <button
            type="button"
            className="btn ghost"
            title="Half width and height"
            onClick={() => scaleCanvasSize(0.5)}
          >
            50%
          </button>
          <button
            type="button"
            className="btn ghost"
            title="Double width and height"
            onClick={() => scaleCanvasSize(2)}
          >
            200%
          </button>
        </div>
        <div className="row">
          <button
            type="button"
            className="btn primary"
            disabled={exporting}
            onClick={runExport}
          >
            {exporting ? 'Exporting…' : 'Export MP4 video'}
          </button>
          {exporting && exportProgress != null ? (
            <span className="progress">{Math.round(exportProgress)}%</span>
          ) : null}
        </div>
        <p className="hint">
          Output is a browser-encoded MP4 (H.264 via WebCodecs). With a mix of photos and videos,
          export length is still the longest video; photos stay on screen for that full length. Audio
          is not mixed. Large resolutions or high FPS can be heavy on CPU.
        </p>
        {statusMessage ? <p className="status">{statusMessage}</p> : null}
      </section>
        </div>

        <aside className="app-preview-pane panel panel--preview" aria-label="Collage preview">
          <h2 className="preview-pane-title">Preview</h2>
          <div
            key={`preview-${Number(exportWidth) || 0}-${Number(exportHeight) || 0}`}
            className="preview-aspect-box preview-aspect-box--pane"
            style={{
              ['--cw']: Math.max(1, canvasSizeMeta.wi || 16),
              ['--ch']: Math.max(1, canvasSizeMeta.hi || 9),
            }}
          >
            <div
              ref={previewAspectInnerRef}
              className="preview-aspect-inner"
              onDoubleClickCapture={(e) => {
                const t = e.target instanceof Element ? e.target : e.target.parentElement
                if (t?.closest('.text-overlay-item')) return
                e.preventDefault()
                const el = previewAspectInnerRef.current
                if (!el) return
                const rect = el.getBoundingClientRect()
                const nx = (e.clientX - rect.left) / rect.width
                const ny = (e.clientY - rect.top) / rect.height
                createTextAtNormalized(nx, ny)
              }}
            >
              <div
                ref={previewHostRef}
                className={
                  Number(borderWidthPx) > 0
                    ? 'grid-preview-host grid-preview-host--bordered'
                    : 'grid-preview-host'
                }
                style={
                  Number(borderWidthPx) > 0
                    ? {
                        padding: `${Number(borderWidthPx) || 0}px`,
                        background: /^#[0-9A-Fa-f]{6}$/.test(borderColor) ? borderColor : '#ffffff',
                      }
                    : undefined
                }
              >
                {useRowMajor ? (
                  <div className="grid-flex-stack" ref={gridFlexStackRef}>
                    {Array.from({ length: rows }, (_, r) => (
                      <Fragment key={r}>
                        {r > 0 ? (
                          <div
                            role="separator"
                            aria-orientation="horizontal"
                            className="splitter-gutter splitter-gutter--row"
                            style={{
                              height: Math.max(Number(borderWidthPx) || 0, 6),
                              background:
                                Number(borderWidthPx) > 0
                                  ? /^#[0-9A-Fa-f]{6}$/.test(borderColor)
                                    ? borderColor
                                    : '#ffffff'
                                  : undefined,
                            }}
                            onMouseDown={(e) => startRowDrag(r - 1, e)}
                          />
                        ) : null}
                        <div
                          className="grid-flex-row"
                          style={{
                            flex: rowSizes[r],
                            minHeight: 0,
                            minWidth: 0,
                          }}
                        >
                          {Array.from({ length: cols }, (_, c) => {
                            const perRow = independentSplits && splitMode === 'perRowCols'
                            const rowWeights = perRow ? colSizesByRow[r] || [] : colSizes
                            const colFlex = perRow ? colSizesByRow[r]?.[c] ?? 1 : colSizes[c]
                            const collapsed = perRow && (colSizesByRow[r]?.[c] ?? 0) <= 0
                            const canCollapse =
                              perRow && (colSizesByRow[r] || []).filter((x) => x > 0).length > 1
                            const showColGutter = c > 0 && showColGutterBefore(rowWeights, c)
                            return (
                              <Fragment key={c}>
                                {showColGutter ? (
                                  <div
                                    role="separator"
                                    aria-orientation="vertical"
                                    className="splitter-gutter splitter-gutter--col"
                                    style={{
                                      width: Math.max(Number(borderWidthPx) || 0, 6),
                                      flexShrink: 0,
                                      background:
                                        Number(borderWidthPx) > 0
                                          ? /^#[0-9A-Fa-f]{6}$/.test(borderColor)
                                            ? borderColor
                                            : '#ffffff'
                                          : undefined,
                                    }}
                                    onMouseDown={(e) =>
                                      startColDrag(
                                        c - 1,
                                        e,
                                        perRow ? r : undefined,
                                      )
                                    }
                                  />
                                ) : null}
                                {renderGridCell(r, c, colFlex, {
                                  collapsed,
                                  rowCollapse: perRow,
                                  colCollapse: false,
                                  canCollapse,
                                  onCollapse: perRow ? () => collapseCellRow(r, c) : undefined,
                                  onRestore: perRow ? () => restoreCellRow(r, c) : undefined,
                                })}
                              </Fragment>
                            )
                          })}
                        </div>
                      </Fragment>
                    ))}
                  </div>
                ) : (
                  <div className="grid-flex-stack grid-flex-stack--by-cols" ref={gridFlexStackRef}>
                    {Array.from({ length: cols }, (_, c) => (
                      <Fragment key={c}>
                        {c > 0 ? (
                          <div
                            role="separator"
                            aria-orientation="vertical"
                            className="splitter-gutter splitter-gutter--col"
                            style={{
                              width: Math.max(Number(borderWidthPx) || 0, 6),
                              flexShrink: 0,
                              background:
                                Number(borderWidthPx) > 0
                                  ? /^#[0-9A-Fa-f]{6}$/.test(borderColor)
                                    ? borderColor
                                    : '#ffffff'
                                  : undefined,
                            }}
                            onMouseDown={(e) => startColDrag(c - 1, e)}
                          />
                        ) : null}
                        <div
                          className="grid-flex-col"
                          ref={(el) => {
                            colStackRefs.current[c] = el
                          }}
                          style={{
                            flex: colSizes[c],
                            minWidth: 0,
                            minHeight: 0,
                            display: 'flex',
                            flexDirection: 'column',
                          }}
                        >
                          {Array.from({ length: rows }, (_, r) => {
                            const perCol = independentSplits && splitMode === 'perColRows'
                            const colWeights = rowSizesByCol[c] || []
                            const rowFlex = rowSizesByCol[c]?.[r] ?? 1
                            const collapsed = perCol && (rowSizesByCol[c]?.[r] ?? 0) <= 0
                            const canCollapse =
                              perCol && colWeights.filter((x) => x > 0).length > 1
                            const showRowGutter = r > 0 && showRowGutterBefore(colWeights, r)
                            return (
                              <Fragment key={r}>
                                {showRowGutter ? (
                                  <div
                                    role="separator"
                                    aria-orientation="horizontal"
                                    className="splitter-gutter splitter-gutter--row"
                                    style={{
                                      height: Math.max(Number(borderWidthPx) || 0, 6),
                                      flexShrink: 0,
                                      background:
                                        Number(borderWidthPx) > 0
                                          ? /^#[0-9A-Fa-f]{6}$/.test(borderColor)
                                            ? borderColor
                                            : '#ffffff'
                                          : undefined,
                                    }}
                                    onMouseDown={(e) => startRowDrag(r - 1, e, c)}
                                  />
                                ) : null}
                                <div
                                  style={
                                    collapsed
                                      ? {
                                          flex: '0 0 52px',
                                          minHeight: 52,
                                          maxHeight: 52,
                                          minWidth: 0,
                                          overflow: 'hidden',
                                          display: 'flex',
                                          flexDirection: 'column',
                                        }
                                      : {
                                          flex: rowFlex,
                                          minHeight: 0,
                                          minWidth: 0,
                                          display: 'flex',
                                          flexDirection: 'column',
                                        }
                                  }
                                >
                                  {renderGridCell(r, c, 1, {
                                    collapsed,
                                    rowCollapse: false,
                                    colCollapse: perCol,
                                    canCollapse,
                                    onCollapse: perCol ? () => collapseCellCol(c, r) : undefined,
                                    onRestore: perCol ? () => restoreCellCol(c, r) : undefined,
                                  })}
                                </div>
                              </Fragment>
                            )
                          })}
                        </div>
                      </Fragment>
                    ))}
                  </div>
                )}
              </div>
              <TextOverlayLayer
                overlays={textOverlays}
                setOverlays={setTextOverlays}
                selectedId={selectedTextId}
                setSelectedId={setSelectedTextId}
                containerRef={previewAspectInnerRef}
              />
            </div>
          </div>
        </aside>
      </div>

      <canvas ref={canvasRef} className="export-canvas" aria-hidden />
    </div>
  )
}
