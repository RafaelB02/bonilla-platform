import type { EstimateRequest, IntakeResult, ServiceType } from './types.ts';

const SERVICE_ES: Record<ServiceType, string> = {
  tree_removal: 'Quitar árbol',
  tree_trimming: 'Podar árbol',
  stump_grinding: 'Moler tocón',
  storm_damage: 'Daño por tormenta',
  other: 'Otro',
};

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** (847) 555-0101 from +18475550101 */
export function formatPhone(e164: string): string {
  const d = e164.slice(-10);
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

export interface AlertEmail {
  subject: string;
  html: string;
  text: string;
}

/** New-lead alert for the owner, written in Spanish. */
export function buildLeadAlert(r: EstimateRequest, result: IntakeResult): AlertEmail {
  const service = SERVICE_ES[r.serviceType];
  const fullAddress = `${r.addressLine1}, ${r.city}, IL ${r.zip}`;
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(fullAddress)}`;
  const kind = r.leadType === 'commercial' ? 'Comercial' : 'Residencial';
  const lang = r.language === 'es' ? 'Español' : 'Inglés';
  const urgent = r.isUrgent ? 'URGENTE: ' : '';

  const subject = `${urgent}Nuevo cliente: ${r.fullName} - ${service} (${r.city})`;

  const rows: Array<[string, string]> = [];
  const textLines: string[] = [];

  if (r.phoneE164) {
    const p = formatPhone(r.phoneE164);
    rows.push([
      'Teléfono',
      `<a href="tel:${r.phoneE164}" style="font-size:20px;font-weight:bold;color:#1a5d1a">${escapeHtml(p)}</a>` +
        (r.smsConsent ? ' <span style="color:#555">(acepta mensajes de texto)</span>' : ''),
    ]);
    textLines.push(`Teléfono: ${p}${r.smsConsent ? ' (acepta textos)' : ''}`);
  }
  if (r.email) {
    rows.push(['Correo', `<a href="mailto:${escapeHtml(r.email)}">${escapeHtml(r.email)}</a>`]);
    textLines.push(`Correo: ${r.email}`);
  }
  rows.push(['Dirección', `<a href="${escapeHtml(mapsUrl)}">${escapeHtml(fullAddress)}</a>`]);
  textLines.push(`Dirección: ${fullAddress}`, `Mapa: ${mapsUrl}`);
  rows.push(['Servicio', escapeHtml(service)]);
  rows.push(['Tipo', kind]);
  rows.push(['Idioma del cliente', lang]);
  textLines.push(`Servicio: ${service}`, `Tipo: ${kind}`, `Idioma del cliente: ${lang}`);

  const desc = r.description ?? '(sin descripción)';
  textLines.push('', 'Descripción:', desc);

  const callButton = r.phoneE164
    ? `<p style="margin:24px 0"><a href="tel:${r.phoneE164}" style="background:#1a5d1a;color:#fff;padding:14px 28px;border-radius:8px;font-size:18px;font-weight:bold;text-decoration:none;display:inline-block">Llamar ahora</a></p>`
    : '';

  const html = `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;font-size:16px;color:#222;max-width:560px;margin:0 auto;padding:16px">
${r.isUrgent ? '<p style="background:#b00020;color:#fff;padding:8px 12px;border-radius:6px;font-weight:bold">URGENTE</p>' : ''}
<h2 style="margin:0 0 8px">${escapeHtml(r.fullName)}</h2>
<p style="margin:0 0 16px;color:#555">Nueva solicitud de estimado desde el sitio web</p>
${callButton}
<table cellpadding="6" style="border-collapse:collapse;width:100%">
${rows.map(([k, v]) => `<tr><td style="color:#555;vertical-align:top;white-space:nowrap">${k}</td><td>${v}</td></tr>`).join('\n')}
</table>
<h3 style="margin:20px 0 6px">Descripción</h3>
<p style="white-space:pre-wrap;margin:0">${escapeHtml(desc)}</p>
<p style="margin-top:28px;font-size:12px;color:#888">Lead ${escapeHtml(result.leadId)}</p>
</body></html>`;

  const text = [
    r.isUrgent ? 'URGENTE' : null,
    `Nuevo cliente: ${r.fullName}`,
    ...textLines,
    '',
    `Lead ${result.leadId}`,
  ]
    .filter((l): l is string => l !== null)
    .join('\n');

  return { subject, html, text };
}

export async function sendAlert(
  apiKey: string,
  from: string,
  to: string,
  email: AlertEmail,
  idempotencyKey: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: true; id: string } | { ok: false; status: number; detail: string }> {
  try {
    const res = await fetchFn('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        // Same key within 24h never sends a second email.
        'Idempotency-Key': `lead-alert/${idempotencyKey}`,
      },
      body: JSON.stringify({ from, to: [to], subject: email.subject, html: email.html, text: email.text }),
      signal: AbortSignal.timeout(10000),
    });
    const data = (await res.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
    if (!res.ok) return { ok: false, status: res.status, detail: data.name ?? data.message ?? 'error' };
    return { ok: true, id: data.id ?? '' };
  } catch (e) {
    return { ok: false, status: 0, detail: e instanceof Error ? e.name : 'network-error' };
  }
}
