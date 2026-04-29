export class ExportStageError extends Error {
  constructor(stage, message, cause = null) {
    super(message)
    this.name = 'ExportStageError'
    this.stage = stage
    this.cause = cause
  }
}
