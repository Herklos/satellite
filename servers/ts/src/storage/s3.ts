import { AwsClient } from "aws4fetch"
import type { IObjectStore } from "../interfaces.js"

export interface S3StorageOptions {
  accessKeyId: string
  secretAccessKey: string
  endpoint: string
  bucket: string
  region?: string
  service?: string
}

export class S3ObjectStore implements IObjectStore {
  private client: AwsClient
  private bucket: string
  private endpoint: string

  constructor(opts: S3StorageOptions) {
    this.client = new AwsClient({
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
      region: opts.region,
      service: opts.service,
    })
    this.endpoint = opts.endpoint
    this.bucket = opts.bucket
  }

  private url(key: string): string {
    return `${this.endpoint}/${this.bucket}/${key}`
  }

  async getString(key: string): Promise<string | null> {
    const res = await this.client.fetch(this.url(key))
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`S3 GET failed: ${res.status}`)
    return res.text()
  }

  async put(
    key: string,
    body: string,
    opts?: { contentType?: string; cacheControl?: string }
  ): Promise<void> {
    const headers: Record<string, string> = {}
    if (opts?.contentType) headers["Content-Type"] = opts.contentType
    if (opts?.cacheControl) headers["Cache-Control"] = opts.cacheControl

    const res = await this.client.fetch(this.url(key), {
      method: "PUT",
      headers,
      body,
    })
    if (!res.ok) throw new Error(`S3 PUT failed: ${res.status}`)
  }

  async list(
    prefix: string,
    opts?: { startAfter?: string; limit?: number }
  ): Promise<string[]> {
    const params = new URLSearchParams({
      "list-type": "2",
      prefix,
    })
    if (opts?.startAfter) params.set("start-after", opts.startAfter)
    if (opts?.limit) params.set("max-keys", String(opts.limit))

    const res = await this.client.fetch(
      `${this.endpoint}/${this.bucket}?${params}`
    )
    if (!res.ok) throw new Error(`S3 LIST failed: ${res.status}`)

    const xml = await res.text()
    const keys: string[] = []
    const regex = /<Key>(.*?)<\/Key>/g
    let match
    while ((match = regex.exec(xml)) !== null) {
      keys.push(match[1]!)
    }
    return keys
  }

  async del(key: string): Promise<void> {
    await this.client.fetch(this.url(key), { method: "DELETE" })
  }

  async delMany(keys: string[]): Promise<void> {
    if (keys.length === 0) return
    const xmlBody = `<Delete>${keys.map(k => `<Object><Key>${k}</Key></Object>`).join("")}</Delete>`
    await this.client.fetch(`${this.endpoint}/${this.bucket}?delete`, {
      method: "POST",
      body: xmlBody,
      headers: { "Content-Type": "application/xml" },
    })
  }
}
