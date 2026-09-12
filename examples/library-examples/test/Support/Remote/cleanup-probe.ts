/** Recovery needs only the dedicated R2 binding, never production WASM or keys. */
interface CleanupEnv {
  EXAMPLE_BUCKET: R2Bucket;
}
export default {
  async fetch(request: Request, env: CleanupEnv): Promise<Response> {
    if (new URL(request.url).pathname === "/health") {
      return new Response("ready");
    }
    if (request.method !== "POST" || new URL(request.url).pathname !== "/run") {
      return new Response("Not available", { status: 404 });
    }
    try {
      const value: unknown = await request.json();
      if (typeof value !== "object" || value === null || !("uploads" in value) || !Array.isArray(value.uploads) || value.uploads.length !== 1) {
        throw new Error("Invalid cleanup scope");
      }
      const upload: unknown = value.uploads[0];
      if (typeof upload !== "object" || upload === null || !("key" in upload) || upload.key !== "archives/encrypted/remote-archive.bin"
        || !("identifier" in upload) || typeof upload.identifier !== "string" || upload.identifier.length === 0 || upload.identifier.length > 2048) {
        throw new Error("Invalid upload receipt");
      }
      await env.EXAMPLE_BUCKET.resumeMultipartUpload(upload.key, upload.identifier).abort();
      return Response.json({ passed: true });
    } catch {
      return Response.json({ passed: false }, { status: 500 });
    }
  },
};
