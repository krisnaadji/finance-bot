// Returns the WhatsApp message ID of the sent message.
// We store this so users can reply to confirmations for edit/delete.
export async function sendWA(to: string, text: string): Promise<string> {
  const gateway = process.env.GATEWAY ?? 'meta';

  if (gateway === 'fonnte') {
    return sendViaFonnte(to, text);
  }
  return sendViaMeta(to, text);
}

// ── Fonnte ───────────────────────────────────────────────────────────
async function sendViaFonnte(to: string, text: string): Promise<string> {
  console.log('Sending via Fonnte to:', to);

  const formData = new URLSearchParams();
  formData.append('target', to);
  formData.append('message', text);
  formData.append('delay', '1');

  const res = await fetch('https://api.fonnte.com/send', {
    method: 'POST',
    headers: {
      Authorization: process.env.FONNTE_TOKEN!,
    },
    body: formData,
  });

  const responseText = await res.text();

  if (!res.ok) throw new Error('Fonnte send failed: ' + responseText);
  const data = JSON.parse(responseText);
  return data.id ?? '';
}

// ── Meta Cloud API ───────────────────────────────────────────────────
async function sendViaMeta(to: string, text: string): Promise<string> {
  const phoneNumberId = process.env.WA_PHONE_NUMBER_ID!;
  const token = process.env.WA_ACCESS_TOKEN!;

  const res = await fetch(
    'https://graph.facebook.com/v22.0/' + phoneNumberId + '/messages',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token,
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text, preview_url: false },
      }),
    },
  );

  if (!res.ok) throw new Error('WhatsApp send failed: ' + (await res.text()));
  const data = await res.json();
  return data.messages?.[0]?.id ?? '';
}
