/**
 * Error classification shared by the plugin and the headless client. Kept out of
 * main.ts (and Obsidian-free) so both clients treat "offline" the same way — a
 * transient network failure gets a quiet backoff, anything else is a real error.
 */

/** DNS/connectivity failures — expected right after a mobile app resume, or while
 *  a container starts before its network is up. */
export function isTransientNetworkError(message: string): boolean {
  return /UnknownHostException|Unable to resolve host|No address associated|ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ECONNABORTED|Failed to fetch|NetworkError|net::ERR|getaddrinfo|ERR_INTERNET_DISCONNECTED|ERR_NETWORK|socket hang up/i.test(
    message,
  );
}
