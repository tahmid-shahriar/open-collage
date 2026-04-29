import { useState } from 'react'

export function useCompositionState() {
  const [textOverlays, setTextOverlays] = useState([])
  const [selectedTextId, setSelectedTextId] = useState(null)

  return {
    textOverlays,
    setTextOverlays,
    selectedTextId,
    setSelectedTextId,
  }
}
