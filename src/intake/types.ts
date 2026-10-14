export type Gateway = 'meta' | 'fonnte';
export interface Delivery {
  gateway: Gateway;
  messageId: string;
  chatId: string;
  rawFrom: string;
  text: string;
  repliedToId: string | null;
  receivedAt: string;
  providerAt: string | null;
  fingerprint: string;
  rejectionCode?: string;
}
export interface InboxClaim {
  id: string;
  fence: string;
  attempt: number;
  leaseUntil: string;
  delivery: Delivery;
  command: unknown | null;
}
export type IngestResult = { ids: string[]; conflicts: string[] };
