export const OUTLOOK_AUTH_ERROR = 'OUTLOOK_AUTH';
export const OUTLOOK_AUTH_MESSAGE = 'Your Outlook connection has expired. Reconnect the account in Mail settings.';

/** True for a Microsoft Graph "token not accepted" failure. */
export const isOutlookAuthError = (err) => err?.code === OUTLOOK_AUTH_ERROR || err?.response?.status === 401;

/**
 * Runs `fn(accessToken)`. When Microsoft rejects the token, refreshes it once and retries with the new one;
 * if the refresh does not work either, throws an OUTLOOK_AUTH error for the caller to report.
 *
 * @param {(accessToken: string) => Promise<any>} fn
 * @param {{ accessToken: string, refresh: () => Promise<boolean>, getFreshToken: () => Promise<string|null> }} deps
 */
export async function withTokenRefresh(fn, { accessToken, refresh, getFreshToken }) {
  try {
    return await fn(accessToken);
  } catch (err) {
    if (!isOutlookAuthError(err)) throw err;
    const refreshed = await refresh();
    const fresh = refreshed ? await getFreshToken() : null;
    if (!fresh) {
      const authError = new Error(OUTLOOK_AUTH_MESSAGE);
      authError.code = OUTLOOK_AUTH_ERROR;
      throw authError;
    }
    return fn(fresh);
  }
}
