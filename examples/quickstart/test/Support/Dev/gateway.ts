/** Test transport only: preserve request/response while selecting a real app Worker. */
export default {
  fetch(request: Request, env: Record<string, Fetcher>): Promise<Response> | Response {
    const url = new URL(request.url);
    const [, application, ...segments] = url.pathname.split("/");
    const binding = env[application];
    if (!binding) return new Response("Unknown test application", { status: 404 });
    url.pathname = "/" + segments.join("/");
    return binding.fetch(new Request(url, request));
  },
};
