export interface AIPayload {
  amount?: number;
  type?: 'income' | 'expense';
  category?: string;
  description?: string;
  date?: string;
  selection_index?: number; // 1-based index for EDIT_FROM_MULTIPLE
  period?: string;
  category_name?: string;
  category_type?: string;
}

export interface AIResponse {
  action:
    | 'CREATE_TRANSACTION'
    | 'CREATE_MULTIPLE' // multiple transactions in one message
    | 'EDIT_FROM_MULTIPLE' // edit one transaction from a multi-transaction reply
    | 'EDIT_TRANSACTION'
    | 'DELETE_TRANSACTION'
    | 'GET_SUMMARY'
    | 'GET_CATEGORIES'
    | 'ADD_CATEGORY'
    | 'CHITCHAT'
    | 'UNKNOWN';
  payload: AIPayload;
  transactions?: AIPayload[]; // used for CREATE_MULTIPLE
  selection_index?: number;
  reply?: string;
}

export interface Account {
  id: string;
  name: string;
  type: 'personal' | 'group';
  wa_chat_id: string;
  language: string;
  owner_id: string;
}

// Note: no groupId field — chatId is always the canonical identifier
// for both DMs (sender phone) and groups (group chat ID)
export interface IncomingMessage {
  messageId: string;
  chatId: string; // DM: sender phone. Group: group chat ID
  text: string;
  repliedToId: string | null;
  rawFrom: string; // always the individual sender's phone
}

export interface TxnForBot {
  id: string;
  description: string;
  amount: number;
  category_name: string;
  date: string;
}

export interface PendingAction {
  id: string;
  account_id: string;
  transaction_id: string;
  action: string;
  expires_at: string;
}
