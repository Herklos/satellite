import { describe, it, expect, vi, beforeEach } from "vitest"

const fetchMock = vi.fn()

vi.mock("aws4fetch", () => ({
  AwsClient: vi.fn().mockImplementation(() => ({
    fetch: fetchMock,
  })),
}))

import { S3ObjectStore } from "../src/index.js"
import { AwsClient } from "aws4fetch"

function mockResponse(status: number, body: string | null = "") {
  return new Response(body, { status })
}

describe("S3ObjectStore", () => {
  let store: S3ObjectStore

  beforeEach(() => {
    fetchMock.mockReset()
    vi.mocked(AwsClient).mockClear()

    store = new S3ObjectStore({
      accessKeyId: "test-key",
      secretAccessKey: "test-secret",
      endpoint: "https://s3.example.com",
      bucket: "test-bucket",
    })
  })

  it("passes credentials to AwsClient", () => {
    expect(AwsClient).toHaveBeenCalledWith({
      accessKeyId: "test-key",
      secretAccessKey: "test-secret",
      region: undefined,
      service: undefined,
    })
  })

  it("passes region and service when provided", () => {
    new S3ObjectStore({
      accessKeyId: "k",
      secretAccessKey: "s",
      endpoint: "https://s3.example.com",
      bucket: "b",
      region: "us-east-1",
      service: "s3",
    })
    expect(AwsClient).toHaveBeenLastCalledWith({
      accessKeyId: "k",
      secretAccessKey: "s",
      region: "us-east-1",
      service: "s3",
    })
  })

  describe("getString", () => {
    it("returns content on 200", async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(200, '{"data":"hello"}'))

      const result = await store.getString("path/to/doc")
      expect(result).toBe('{"data":"hello"}')
      expect(fetchMock).toHaveBeenCalledWith("https://s3.example.com/test-bucket/path/to/doc")
    })

    it("returns null on 404", async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(404))

      const result = await store.getString("missing/key")
      expect(result).toBeNull()
    })

    it("throws on non-ok status", async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(500))

      await expect(store.getString("error/key")).rejects.toThrow("S3 GET failed: 500")
    })
  })

  describe("put", () => {
    it("sends PUT request with body", async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(200))

      await store.put("path/to/doc", '{"key":"value"}')
      expect(fetchMock).toHaveBeenCalledWith(
        "https://s3.example.com/test-bucket/path/to/doc",
        { method: "PUT", headers: {}, body: '{"key":"value"}' }
      )
    })

    it("includes Content-Type header when provided", async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(200))

      await store.put("doc", "body", { contentType: "application/json" })
      expect(fetchMock).toHaveBeenCalledWith(
        "https://s3.example.com/test-bucket/doc",
        { method: "PUT", headers: { "Content-Type": "application/json" }, body: "body" }
      )
    })

    it("includes Cache-Control header when provided", async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(200))

      await store.put("doc", "body", { cacheControl: "max-age=3600" })
      expect(fetchMock).toHaveBeenCalledWith(
        "https://s3.example.com/test-bucket/doc",
        { method: "PUT", headers: { "Cache-Control": "max-age=3600" }, body: "body" }
      )
    })

    it("includes both headers when provided", async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(200))

      await store.put("doc", "body", { contentType: "text/plain", cacheControl: "no-cache" })
      expect(fetchMock).toHaveBeenCalledWith(
        "https://s3.example.com/test-bucket/doc",
        { method: "PUT", headers: { "Content-Type": "text/plain", "Cache-Control": "no-cache" }, body: "body" }
      )
    })

    it("throws on non-ok status", async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(403))

      await expect(store.put("doc", "body")).rejects.toThrow("S3 PUT failed: 403")
    })
  })

  describe("list", () => {
    it("parses keys from XML response", async () => {
      const xml = `
        <ListBucketResult>
          <Contents><Key>docs/a</Key></Contents>
          <Contents><Key>docs/b</Key></Contents>
          <Contents><Key>docs/c</Key></Contents>
        </ListBucketResult>
      `
      fetchMock.mockResolvedValueOnce(mockResponse(200, xml))

      const keys = await store.list("docs/")
      expect(keys).toEqual(["docs/a", "docs/b", "docs/c"])
    })

    it("sends correct query params", async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(200, "<ListBucketResult></ListBucketResult>"))

      await store.list("prefix/", { startAfter: "prefix/cursor", limit: 10 })
      const url = fetchMock.mock.calls[0][0] as string
      expect(url).toContain("list-type=2")
      expect(url).toContain("prefix=prefix%2F")
      expect(url).toContain("start-after=prefix%2Fcursor")
      expect(url).toContain("max-keys=10")
    })

    it("returns empty array when no keys", async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(200, "<ListBucketResult></ListBucketResult>"))

      const keys = await store.list("empty/")
      expect(keys).toEqual([])
    })

    it("throws on non-ok status", async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(500))

      await expect(store.list("prefix/")).rejects.toThrow("S3 LIST failed: 500")
    })
  })

  describe("del", () => {
    it("sends DELETE request", async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(204, null))

      await store.del("path/to/doc")
      expect(fetchMock).toHaveBeenCalledWith(
        "https://s3.example.com/test-bucket/path/to/doc",
        { method: "DELETE" }
      )
    })
  })

  describe("delMany", () => {
    it("sends POST with XML delete body", async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(200))

      await store.delMany(["a", "b", "c"])
      const [url, opts] = fetchMock.mock.calls[0]
      expect(url).toBe("https://s3.example.com/test-bucket?delete")
      expect(opts.method).toBe("POST")
      expect(opts.body).toContain("<Delete>")
      expect(opts.body).toContain("<Object><Key>a</Key></Object>")
      expect(opts.body).toContain("<Object><Key>b</Key></Object>")
      expect(opts.body).toContain("<Object><Key>c</Key></Object>")
      expect(opts.headers["Content-Type"]).toBe("application/xml")
    })

    it("skips request for empty array", async () => {
      await store.delMany([])
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })
})
