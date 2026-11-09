const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export interface TurnstileOutcome {
  success: boolean;
  errorCodes: string[];
}

/**
 * Verify a Turnstile token server-side. Tokens are single-use and expire
 * after 300 seconds. Rejects tokens issued for hostnames we don't own.
 */
export async function verifyTurnstile(
  token: string,
  secret: string,
  allowedHostnames: string[],
  remoteIp: string | null,
  fetchFn: typeof fetch = fetch,
): Promise<TurnstileOutcome> {
  const body: Record<string, string> = { secret, response: token };
  if (remoteIp) body.remoteip = remoteIp;

  let res: Response;
  try {
    res = await fetchFn(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return { success: false, errorCodes: ['network-error'] };
  }

  if (!res.ok) return { success: false, errorCodes: [`http-${res.status}`] };

  const data = (await res.json().catch(() => null)) as {
    success?: boolean;
    hostname?: string;
    'error-codes'?: string[];
  } | null;

  if (!data || data.success !== true) {
    return { success: false, errorCodes: data?.['error-codes'] ?? ['invalid-response'] };
  }
  if (allowedHostnames.length > 0 && !allowedHostnames.includes(data.hostname ?? '')) {
    return { success: false, errorCodes: ['hostname-mismatch'] };
  }
  return { success: true, errorCodes: [] };
}
