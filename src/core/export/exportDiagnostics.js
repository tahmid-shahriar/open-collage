export function createDiagnostic({ stage, assetId = null, frame = null, message }) {
  return {
    stage,
    assetId,
    frame,
    message,
    at: new Date().toISOString(),
  }
}
