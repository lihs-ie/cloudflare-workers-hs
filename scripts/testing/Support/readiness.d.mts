/** Wait through response-body completion within one startup deadline. */
export function fetchReadiness(
  url: string,
  deadline: number,
  options?: RequestInit & { now?: () => number },
): Promise<Response>;
