import type { EstimateRequest, IntakeResult } from './types.ts';

export class SupabaseError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = 'SupabaseError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Supabase accepts the new secret keys (sb_secret_...) in the `apikey`
 * header. Legacy service_role keys are JWTs and also go in Authorization.
 */
function authHeaders(serviceKey: string): Record<string, string> {
  const h: Record<string, string> = { apikey: serviceKey };
  if (serviceKey.startsWith('eyJ')) h.Authorization = `Bearer ${serviceKey}`;
  return h;
}

/** Named arguments for public.create_inbound_lead(). Keys must match the SQL. */
export function toRpcArgs(r: EstimateRequest, sourceCode = 'website'): Record<string, unknown> {
  return {
    p_intake_key: r.intakeKey,
    p_full_name: r.fullName,
    p_phone: r.phoneE164,
    p_email: r.email,
    p_language: r.language,
    p_address_line1: r.addressLine1,
    p_city: r.city,
    p_zip: r.zip,
    p_service_type: r.serviceType,
    p_lead_type: r.leadType,
    p_description: r.description,
    p_is_urgent: r.isUrgent,
    p_source_code: sourceCode,
    p_sms_consent: r.smsConsent,
    p_consent_text: r.consentText,
  };
}

export async function createInboundLead(
  supabaseUrl: string,
  serviceKey: string,
  r: EstimateRequest,
  fetchFn: typeof fetch = fetch,
): Promise<IntakeResult> {
  const res = await fetchFn(`${supabaseUrl.replace(/\/+$/, '')}/rest/v1/rpc/create_inbound_lead`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(serviceKey) },
    body: JSON.stringify(toRpcArgs(r)),
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { message?: string; code?: string } | null;
    throw new SupabaseError(err?.message ?? `HTTP ${res.status}`, res.status, err?.code ?? null);
  }

  const rows = (await res.json()) as Array<{ lead_id: string; contact_id: string; is_duplicate: boolean }>;
  const row = rows[0];
  if (!row?.lead_id) throw new SupabaseError('empty RPC response', 502, null);
  return { leadId: row.lead_id, contactId: row.contact_id, isDuplicate: row.is_duplicate };
}

/** Append a system note to the lead's timeline (best effort). */
export async function logActivity(
  supabaseUrl: string,
  serviceKey: string,
  contactId: string,
  leadId: string,
  body: string,
  metadata: Record<string, unknown>,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchFn(`${supabaseUrl.replace(/\/+$/, '')}/rest/v1/activities`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
      ...authHeaders(serviceKey),
    },
    body: JSON.stringify({ contact_id: contactId, lead_id: leadId, type: 'system', body, metadata }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new SupabaseError(`activity log failed: HTTP ${res.status}`, res.status, null);
}
