export interface Env {
  /** e.g. https://abcd1234.supabase.co (plain var) */
  SUPABASE_URL: string;
  /** Supabase secret key (sb_secret_...) or legacy service_role JWT (secret) */
  SUPABASE_SERVICE_ROLE_KEY: string;
  /** Cloudflare Turnstile secret key (secret) */
  TURNSTILE_SECRET_KEY: string;
  /** Resend API key (secret) */
  RESEND_API_KEY: string;
  /** Where new-lead alerts go (plain var) */
  ALERT_TO_EMAIL: string;
  /** Sender, e.g. "Bonilla Leads <onboarding@resend.dev>" (plain var) */
  ALERT_FROM_EMAIL: string;
  /** Comma-separated origins allowed to post the form (plain var) */
  ALLOWED_ORIGINS: string;
  /** Comma-separated hostnames Turnstile tokens must come from (plain var) */
  TURNSTILE_HOSTNAMES: string;
}

/** Minimal subset of the Workers ExecutionContext we use. */
export interface Ctx {
  waitUntil(promise: Promise<unknown>): void;
}

export const SERVICE_TYPES = [
  'tree_removal',
  'tree_trimming',
  'stump_grinding',
  'storm_damage',
  'other',
] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];

export const LEAD_TYPES = ['residential', 'commercial'] as const;
export type LeadType = (typeof LEAD_TYPES)[number];

export const LANGUAGES = ['es', 'en'] as const;
export type Language = (typeof LANGUAGES)[number];

/** A form submission after validation and normalization. */
export interface EstimateRequest {
  intakeKey: string;
  fullName: string;
  phoneE164: string | null;
  email: string | null;
  language: Language;
  addressLine1: string;
  city: string;
  zip: string;
  serviceType: ServiceType;
  leadType: LeadType;
  description: string | null;
  isUrgent: boolean;
  smsConsent: boolean;
  consentText: string | null;
  turnstileToken: string;
}

export interface IntakeResult {
  leadId: string;
  contactId: string;
  isDuplicate: boolean;
}
