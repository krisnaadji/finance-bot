// Format number as Indonesian rupiah: 35000 → '35.000'
export function formatIDR(amount: number): string {
  return amount.toLocaleString('id-ID');
}

// Format date for WA display based on language
// 2026-03-27 → '27 Mar 2026' (id) or 'Mar 27, 2026' (en)
export function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('id-ID', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

// Check if message is a yes/no confirmation
export function isYes(text: string): boolean {
  return /^(ya|yes|y|ok|oke|yep|yup|iya)$/i.test(text.trim());
}
export function isNo(text: string): boolean {
  return /^(tidak|no|n|batal|cancel|nope)$/i.test(text.trim());
}
export function isYesNo(text: string): boolean {
  return isYes(text) || isNo(text);
}
