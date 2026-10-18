import { isBusinessDate, isRecord, isUuid, parseAmount } from '../utils/financialValidation';

export type Decimal = string;
export type TxnInput = { categoryId: string | null; amount: Decimal; type: 'income' | 'expense'; description: string; date: string };
export type Reply = { text: string; kind: 'ordinary' | 'receipt' | 'help' | 'confirmation' };
export type PreparedCommand =
  | { kind: 'create'; accountId: string; rows: TxnInput[]; recordedByName: string | null }
  | { kind: 'edit'; accountId: string; transactionId: string; before: TxnInput; editedByName: string; patch: Partial<TxnInput> }
  | { kind: 'delete_prompt'; accountId: string; transactionId: string }
  | { kind: 'delete_decision'; accountId: string; pendingId: string; confirmationMessageId: string; decision: 'confirm' | 'cancel' }
  | { kind: 'add_category'; accountId: string; nameId: string | null; nameEn: string | null; parentId: string | null; type: 'income' | 'expense' }
  | { kind: 'setup'; code: string; language: 'id' | 'en' }
  | { kind: 'set_language'; accountId: string; language: 'id' | 'en' }
  | { kind: 'reply'; accountId: string | null; reply: Reply };
export interface CommitResult {
  outcome: 'committed' | 'replayed' | 'rejected';
  code: string;
  batchId: string | null;
  transactionIds: string[];
  outboundIds: string[];
}

function invalid(): never { throw new Error('Invalid prepared command'); }
function uuid(value: unknown): string { return isUuid(value) ? value : invalid(); }
function text(value: unknown): string { return typeof value === 'string' ? value : invalid(); }
function lang(value: unknown): 'id' | 'en' { return value === 'id' || value === 'en' ? value : invalid(); }
function txnType(value: unknown): 'income' | 'expense' { return value === 'income' || value === 'expense' ? value : invalid(); }
function keys(row: Record<string,unknown>, allowed: string[]): void {
  if (Object.keys(row).some(k => !allowed.includes(k))) invalid();
}
function transaction(value: unknown, partial: false): TxnInput;
function transaction(value: unknown, partial: true): Partial<TxnInput>;
function transaction(value: unknown, partial: boolean): Partial<TxnInput> {
  if (!isRecord(value)) invalid();
  keys(value,['categoryId','amount','type','description','date']);
  if (!partial && ['categoryId','amount','type','description','date'].some(k => !Object.hasOwn(value,k))) invalid();
  const result: Partial<TxnInput> = {};
  if (Object.hasOwn(value,'categoryId')) result.categoryId = value.categoryId === null ? null : uuid(value.categoryId);
  if (Object.hasOwn(value,'amount')) {
    const amount = parseAmount(value.amount);
    if (typeof value.amount !== 'string' || amount === null || amount !== value.amount) invalid();
    result.amount = amount;
  }
  if (Object.hasOwn(value,'type')) result.type = txnType(value.type);
  if (Object.hasOwn(value,'description')) result.description = text(value.description);
  if (Object.hasOwn(value,'date')) {
    if (!isBusinessDate(value.date)) invalid();
    result.date = value.date;
  }
  if (partial && Object.keys(result).length === 0) invalid();
  return result;
}
export function decodeCommand(value: unknown): PreparedCommand {
  if (!isRecord(value)) invalid();
  const kind = value.kind;
  switch (kind) {
    case 'create': {
      keys(value,['kind','accountId','rows','recordedByName']);
      if (!Array.isArray(value.rows) || value.rows.length < 1 || value.rows.length > 100) invalid();
      const rows = value.rows.map(row => transaction(row,false));
      return { kind,accountId:uuid(value.accountId),rows,recordedByName:value.recordedByName === null ? null : text(value.recordedByName) };
    }
    case 'edit':
      keys(value,['kind','accountId','transactionId','before','editedByName','patch']);
      return { kind,accountId:uuid(value.accountId),transactionId:uuid(value.transactionId),
        before:transaction(value.before,false),editedByName:text(value.editedByName),patch:transaction(value.patch,true) };
    case 'delete_prompt':
      keys(value,['kind','accountId','transactionId']);
      return { kind,accountId:uuid(value.accountId),transactionId:uuid(value.transactionId) };
    case 'delete_decision': {
      keys(value,['kind','accountId','pendingId','confirmationMessageId','decision']);
      if (value.decision !== 'confirm' && value.decision !== 'cancel') invalid();
      const confirmationMessageId=text(value.confirmationMessageId);
      if (!confirmationMessageId) invalid();
      return { kind,accountId:uuid(value.accountId),pendingId:uuid(value.pendingId),confirmationMessageId,decision:value.decision };
    }
    case 'add_category': {
      keys(value,['kind','accountId','nameId','nameEn','parentId','type']);
      const nameId=value.nameId === null ? null : text(value.nameId).trim();
      const nameEn=value.nameEn === null ? null : text(value.nameEn).trim();
      if ((!nameId && !nameEn) || (nameId !== null && (!nameId || [...nameId].length > 120)) || (nameEn !== null && (!nameEn || [...nameEn].length > 120))) invalid();
      return {kind,accountId:uuid(value.accountId),nameId,nameEn,parentId:value.parentId === null ? null : uuid(value.parentId),type:txnType(value.type)};
    }
    case 'setup': {
      keys(value,['kind','code','language']);
      const code=text(value.code);
      if (!code.trim()) invalid();
      return { kind,code,language:lang(value.language) };
    }
    case 'set_language':
      keys(value,['kind','accountId','language']);
      return { kind,accountId:uuid(value.accountId),language:lang(value.language) };
    case 'reply': {
      keys(value,['kind','accountId','reply']);
      if (!isRecord(value.reply)) invalid();
      keys(value.reply,['text','kind']);
      if (value.reply.kind !== 'ordinary' && value.reply.kind !== 'help') invalid();
      return { kind,accountId:value.accountId === null ? null : uuid(value.accountId),reply:{text:text(value.reply.text),kind:value.reply.kind} };
    }
    default: return invalid();
  }
}
