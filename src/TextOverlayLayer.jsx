import { useCallback, useEffect, useRef, useState } from 'react'
import { typewriterDurationSec } from './textOverlayUtils.js'
import './TextOverlayLayer.css'

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v))
}

function previewAnimClass(animation) {
  if (!animation || animation === 'none' || animation === 'typewriter') return ''
  return `text-overlay-item--preview-${animation}`
}

/** Preview typing animation; timing matches export (`typewriterDurationSec`). */
function TypewriterPreview({ text }) {
  const base = text || 'Text'
  const [n, setN] = useState(0)
  const rafRef = useRef(0)

  useEffect(() => {
    const start = performance.now()
    const durMs = typewriterDurationSec(base) * 1000

    const tick = () => {
      const elapsed = performance.now() - start
      const p = durMs <= 0 ? 1 : Math.min(1, elapsed / durMs)
      setN(Math.floor(base.length * p))
      if (p < 1) {
        rafRef.current = requestAnimationFrame(tick)
      }
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [base])

  return base.slice(0, n)
}

export default function TextOverlayLayer({
  overlays,
  setOverlays,
  selectedId,
  setSelectedId,
  containerRef,
}) {
  const updateOverlay = useCallback(
    (id, patch) => {
      setOverlays((prev) => prev.map((o) => (o.id === id ? { ...o, ...patch } : o)))
    },
    [setOverlays],
  )

  const startDrag = useCallback(
    (id, e) => {
      if (e.target.closest('.text-overlay-resize')) return
      e.stopPropagation()
      e.preventDefault()
      setSelectedId(id)
      const el = containerRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const o = overlays.find((x) => x.id === id)
      if (!o) return
      const startX = e.clientX
      const startY = e.clientY
      const origNx = o.nx
      const origNy = o.ny

      const onMove = (ev) => {
        const dx = (ev.clientX - startX) / rect.width
        const dy = (ev.clientY - startY) / rect.height
        updateOverlay(id, {
          nx: clamp(origNx + dx, 0, 1 - o.nw),
          ny: clamp(origNy + dy, 0, 1 - o.nh),
        })
      }
      const onUp = () => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [containerRef, overlays, setSelectedId, updateOverlay],
  )

  const startResize = useCallback(
    (id, e) => {
      e.stopPropagation()
      e.preventDefault()
      setSelectedId(id)
      const el = containerRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const o = overlays.find((x) => x.id === id)
      if (!o) return
      const startX = e.clientX
      const startY = e.clientY
      const origNw = o.nw
      const origNh = o.nh

      const onMove = (ev) => {
        const dx = (ev.clientX - startX) / rect.width
        const dy = (ev.clientY - startY) / rect.height
        updateOverlay(id, {
          nw: clamp(origNw + dx, 0.04, 1 - o.nx),
          nh: clamp(origNh + dy, 0.04, 1 - o.ny),
        })
      }
      const onUp = () => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [containerRef, overlays, setSelectedId, updateOverlay],
  )

  return (
    <div
      className="text-overlay-layer"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setSelectedId(null)
      }}
      role="presentation"
    >
      {overlays.map((o) => (
        <div
          key={o.id}
          className={`text-overlay-item ${selectedId === o.id ? 'text-overlay-item--selected' : ''} ${previewAnimClass(o.animation)}`}
          style={{
            left: `${o.nx * 100}%`,
            top: `${o.ny * 100}%`,
            width: `${o.nw * 100}%`,
            height: `${o.nh * 100}%`,
            color: /^#[0-9A-Fa-f]{6}$/i.test(o.color) ? o.color : '#ffffff',
            fontSize: `${Math.max(9, Math.min(72, (o.fontPx || 32) * 0.14))}px`,
          }}
          onMouseDown={(e) => startDrag(o.id, e)}
        >
          <div className="text-overlay-item-inner">
            {o.animation === 'typewriter' ? (
              <TypewriterPreview key={`${o.id}-${String(o.text)}`} text={o.text} />
            ) : (
              o.text || 'Text'
            )}
          </div>
          {selectedId === o.id ? (
            <button
              type="button"
              className="text-overlay-resize"
              aria-label="Resize"
              onMouseDown={(e) => startResize(o.id, e)}
            />
          ) : null}
        </div>
      ))}
    </div>
  )
}
