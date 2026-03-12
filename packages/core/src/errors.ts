export class StartupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "StartupError"
  }
}

export class AuthError extends Error {
  public readonly status: 401 | 403

  constructor(message: string, status: 401 | 403) {
    super(message)
    this.name = "AuthError"
    this.status = status
  }
}

export class ConflictError extends Error {
  public readonly docId: string

  constructor(docId: string) {
    super(`Conflict on document: ${docId}`)
    this.name = "ConflictError"
    this.docId = docId
  }
}

export class NotFoundError extends Error {
  public readonly key: string

  constructor(key: string) {
    super(`Not found: ${key}`)
    this.name = "NotFoundError"
    this.key = key
  }
}
