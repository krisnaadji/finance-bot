// Returns the WhatsApp message ID of the sent message.
// We store this so users can reply to confirmations for edit/delete.
export async function sendWA(to: string, text: string): Promise<string> {
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
