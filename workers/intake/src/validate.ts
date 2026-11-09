import {
  LANGUAGES,
  LEAD_TYPES,
  SERVICE_TYPES,
  type EstimateRequest,
  type Language,
  type LeadType,
  type ServiceType,
} from './types.ts';

export type FieldErrors = Record<string, string>;

export type ValidationResult =
  | { ok: true; value: EstimateRequest }
  | { ok: false; errors: FieldErrors }
  | { ok: false; spam: true };

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const ZIP_RE = /^[0-9]{5}$/;
const INTAKE_KEY_RE = /^[A-Za-z0-9-]{8,100}$/;

/** Mirrors public.normalize_us_phone() in the database. */
export function normalizeUsPhone(raw: string): string | null {
  const d = raw.replace(/[^0-9]/g, '');
  if (/^1[2-9][0-9]{9}$/.test(d)) return `+${d}`;
  if (/^[2-9][0-9]{9}$/.test(d)) return `+1${d}`;
  return null;
}

/** Trim, collapse inner whitespace, strip control characters. */
function clean(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (s === '') return null;
  return s.length > max ? s.slice(0, max) : s;
}

function oneLine(v: unknown, max: number): string | null {
  const s = clean(v, max);
  return s === null ? null : s.replace(/\s+/g, ' ');
}

function isOneOf<T extends string>(list: readonly T[], v: unknown): v is T {
  return typeof v === 'string' && (list as readonly string[]).includes(v);
}

function bool(v: unknown): boolean {
  return v === true || v === 'true' || v === 'on' || v === '1';
}

export function validateEstimateRequest(input: unknown): ValidationResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: { _form: 'invalid_body' } };
  }
  const b = input as Record<string, unknown>;

  // Honeypot: real people never see or fill this field.
  if (typeof b.company_website === 'string' && b.company_website.trim() !== '') {
    return { ok: false, spam: true };
  }

  const errors: FieldErrors = {};

  const intakeKey = typeof b.intake_key === 'string' ? b.intake_key : '';
  if (!INTAKE_KEY_RE.test(intakeKey)) errors.intake_key = 'invalid';

  const fullName = oneLine(b.name, 200);
  if (!fullName || fullName.length < 2) errors.name = 'required';

  const rawPhone = oneLine(b.phone, 40);
  const phoneE164 = rawPhone ? normalizeUsPhone(rawPhone) : null;
  if (rawPhone && !phoneE164) errors.phone = 'invalid';

  const rawEmail = oneLine(b.email, 254);
  const email = rawEmail ? rawEmail.toLowerCase() : null;
  if (email && !EMAIL_RE.test(email)) errors.email = 'invalid';

  if (!rawPhone && !rawEmail) errors.phone = 'phone_or_email_required';

  const addressLine1 = oneLine(b.address, 200);
  if (!addressLine1 || addressLine1.length < 3) errors.address = 'required';

  const city = oneLine(b.city, 100);
  if (!city || city.length < 2) errors.city = 'required';

  const zip = oneLine(b.zip, 10);
  if (!zip || !ZIP_RE.test(zip)) errors.zip = 'invalid';

  const serviceType: ServiceType = isOneOf(SERVICE_TYPES, b.service) ? b.service : 'other';
  if (b.service !== undefined && !isOneOf(SERVICE_TYPES, b.service)) errors.service = 'invalid';

  const leadType: LeadType = isOneOf(LEAD_TYPES, b.lead_type) ? b.lead_type : 'residential';
  const language: Language = isOneOf(LANGUAGES, b.language) ? b.language : 'en';

  const description = clean(b.description, 2000);

  const turnstileToken = typeof b.turnstile_token === 'string' ? b.turnstile_token : '';
  if (turnstileToken.length < 10 || turnstileToken.length > 2048) {
    errors.turnstile_token = 'required';
  }

  const smsConsent = bool(b.sms_consent) && phoneE164 !== null;
  const consentText = smsConsent ? oneLine(b.consent_text, 1000) : null;

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      intakeKey,
      fullName: fullName!,
      phoneE164,
      email,
      language,
      addressLine1: addressLine1!,
      city: city!,
      zip: zip!,
      serviceType,
      leadType,
      description,
      isUrgent: bool(b.urgent),
      smsConsent,
      consentText,
      turnstileToken,
    },
  };
}
