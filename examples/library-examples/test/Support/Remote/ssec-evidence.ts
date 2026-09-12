/** Classification of observations, never a claim of encryption rejection.
 * Cloudflare's documented code table has no SSE-C-specific rejection code.
 * Never retain native messages, which may include sensitive diagnostics.
 */
export function observeReadFailure(error: unknown): "service-or-transport-error" | "unclassified-error" {
  if (error instanceof Error && /\((10001|10013|10043|10054|10058)\)$/.test(error.message)) {
    return "service-or-transport-error";
  }
  return "unclassified-error";
}
