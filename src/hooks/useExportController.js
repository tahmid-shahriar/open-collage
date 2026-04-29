import { useState } from 'react'

export function useExportController() {
  const [exporting, setExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState(null)
  const [statusMessage, setStatusMessage] = useState('')

  return {
    exporting,
    exportProgress,
    statusMessage,
    setExporting,
    setExportProgress,
    setStatusMessage,
  }
}
