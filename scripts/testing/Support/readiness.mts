/** Wait through the response body using the caller's single startup deadline. */
export async function fetchReadiness(
  url: string,
  deadline: number,
  options: RequestInit & { now?: () => number } = {},
): Promise<Response> {
  const { now = Date.now, ...init } = options;
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(Math.max(1, Math.ceil(deadline - now()))),
  });
  await response.arrayBuffer();
  return response;
}
