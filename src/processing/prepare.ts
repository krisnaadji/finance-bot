import { supabase } from '../services/supabase';
import { callAI } from '../ai';
import type { Account, AIPayload, AIResponse, PendingAction, TxnForBot } from '../ai/types';
import { InvalidAICommand, validateAIResponse } from '../ai/validation';
import { t } from '../i18n/bot';
import { resolveLang, SUPPORTED_LANGS } from '../utils/lang';
import type { Lang } from '../utils/lang';
import { isNo, isYesNo } from '../utils/format';
import { isRecord, isUuid } from '../utils/financialValidation';
import type { InboxClaim } from '../intake/types';
import { BotWriteError, canonicalTxn, loadWriteContext, resolveCategory, transactionColumns } from '../handlers/transactionData';
import type { CanonicalTxn, CategoryRow } from '../handlers/transactionData';
import { categoriesReply } from '../handlers/getCategories';
import { summaryReply } from '../handlers/getSummary';
import { searchReply } from '../handlers/searchTxn';
import { helpShortcutHint, loadHelpContext, summaryShortcutAi } from '../handlers/helpMenu';
import type { HelpShortcut } from '../handlers/helpMenu';
import { parseSalaryPeriodArgs } from '../handlers/salaryPeriodArgs';
import { lookupReceipt } from './commit';
import { decodeCommand } from './types';
import type { PreparedCommand, TxnInput } from './types';

async function accountForChat(chatId: string): Promise<Account | null> {
  const {data,error}=await supabase.from('accounts').select('*').eq('wa_chat_id',chatId).eq('is_active',true).maybeSingle();
  if (error) throw new BotWriteError('dependency');
  if (data === null) return null;
  if (!isRecord(data) || !isUuid(data.id) || !isUuid(data.owner_id) || typeof data.name !== 'string' ||
      (data.type !== 'personal' && data.type !== 'group') || typeof data.language !== 'string' ||
      data.wa_chat_id !== chatId || data.is_active !== true) throw new BotWriteError('dependency');
  return {id:data.id,name:data.name,owner_id:data.owner_id,type:data.type,language:data.language,wa_chat_id:chatId,is_active:true};
}
async function pendingFor(claim: InboxClaim, accountId: string, onlyRequester: boolean): Promise<PendingAction | null> {
  const d=claim.delivery;
  let query=supabase.from('pending_actions').select('*').eq('account_id',accountId).eq('wa_chat_id',d.chatId).eq('action','DELETE');
  if (onlyRequester) query=query.eq('requested_by_phone',d.rawFrom);
  if (d.repliedToId !== null) query=query.eq('confirmation_message_id',d.repliedToId);
  else if (!onlyRequester) return null;
  const {data,error}=await query.maybeSingle();
  if (error) throw new BotWriteError('dependency');
  if (data === null || data.confirmation_message_id === null) return null;
  if (!isRecord(data) || !isUuid(data.id) || !isUuid(data.transaction_id) || data.account_id !== accountId ||
      data.wa_chat_id !== d.chatId || typeof data.requested_by_phone !== 'string' ||
      typeof data.confirmation_message_id !== 'string' || !data.confirmation_message_id || typeof data.expires_at !== 'string') throw new BotWriteError('dependency');
  return {id:data.id,account_id:accountId,transaction_id:data.transaction_id,action:'DELETE',wa_chat_id:d.chatId,
    requested_by_phone:data.requested_by_phone,confirmation_message_id:data.confirmation_message_id,expires_at:data.expires_at};
}
function input(txn: CanonicalTxn): TxnInput {
  return {categoryId:txn.category_id,amount:txn.amount,type:txn.type,description:txn.description,date:txn.date};
}
function createInput(p: AIPayload, categories: CategoryRow[]): TxnInput {
  return {categoryId:resolveCategory(p.category,p.type!,categories)?.id ?? null,amount:p.amount!,type:p.type!,
    description:p.description ?? '',date:p.date!};
}
function dashboardReply(lang: Lang): string {
  const url=process.env.DASHBOARD_URL ?? 'Not configured';
  return lang === 'id' ? `📱 *Dashboard Finance Bot*\n\n${url}\n\nLihat ringkasan, transaksi, dan kelola akun di sini.`
    : `📱 *Finance Bot Dashboard*\n\n${url}\n\nView summaries, transactions, and manage your account here.`;
}

export async function prepareMessage(claim: InboxClaim): Promise<PreparedCommand> {
  if (claim.command !== null) return decodeCommand(claim.command);
  const d=claim.delivery, text=d.text.trim();
  let account: Account | null=null, lang: Lang='id';
  const reply=(value:string,kind:'ordinary'|'help'='ordinary'):PreparedCommand=>({kind:'reply',accountId:account?.id ?? null,reply:{text:value,kind}});
  try {
    if (text.startsWith('/setup')) {
      const parts=text.split(/\s+/);
      lang=SUPPORTED_LANGS.includes(parts[2] as Lang) ? parts[2] as Lang : 'id';
      return parts[1] ? {kind:'setup',code:parts[1].toUpperCase(),language:lang} : reply('Format: /setup KODE  or  /setup KODE en');
    }
    account=await accountForChat(d.chatId);
    if (!account) return reply(t.id.notSetup(process.env.DASHBOARD_URL ?? ''));
    const pref=await supabase.from('members').select('language_pref').eq('account_id',account.id).eq('wa_phone',d.rawFrom).maybeSingle();
    if (pref.error) throw new BotWriteError('dependency');
    lang=resolveLang(account.language,typeof pref.data?.language_pref === 'string' ? pref.data.language_pref : null);
    if (isYesNo(text)) {
      if (process.env.DELETE_CONFIRMATIONS_ENABLED !== 'true') return reply(t[lang].confirmationUnsupported);
      const pending=await pendingFor(claim,account.id,true);
      if (!pending || pending.requested_by_phone !== d.rawFrom) return reply(t[lang].confirmationUnsupported);
      return {kind:'delete_decision',accountId:account.id,pendingId:pending.id,
        confirmationMessageId:pending.confirmation_message_id!,decision:isNo(text) ? 'cancel' : 'confirm'};
    }
    if (d.repliedToId && await pendingFor(claim,account.id,false)) return reply(t[lang].confirmationUnsupported);
    if (text === '/help') return reply(t[lang].helpText,'help');
    if (text.startsWith('/language')) {
      const next=text.split(/\s+/)[1]?.toLowerCase();
      return next === 'id' || next === 'en' ? {kind:'set_language',accountId:account.id,language:next}
        : reply('Supported: /language id   or   /language en');
    }
    if (text === '/dashboard') return reply(dashboardReply(lang));
    if (d.repliedToId) {
      if (await loadHelpContext(account.id,d.chatId,d.repliedToId)) {
        const shortcuts:Record<string,HelpShortcut>={'1':'summary','2':'salary_summary','3':'categories','4':'search_hint','5':'dashboard','6':'language_hint','7':'setup_hint'};
        const shortcut=shortcuts[text];
        if (shortcut === 'summary' || shortcut === 'salary_summary') return reply(await summaryReply(summaryShortcutAi(shortcut === 'summary' ? 'this_month' : 'salary_cycle'),account,lang,new Date(d.receivedAt)));
        if (shortcut === 'categories') return reply(await categoriesReply(account,lang));
        if (shortcut === 'dashboard') return reply(dashboardReply(lang));
        if (shortcut) return reply(helpShortcutHint(shortcut,lang));
      }
    }
    const salaryArgs=text === '/rekap gaji' || text === '/summary salary' ? ''
      : text.startsWith('/rekap gaji ') ? text.slice('/rekap gaji'.length)
      : text.startsWith('/summary salary ') ? text.slice('/summary salary'.length) : null;
    if (salaryArgs !== null) {
      const parsed=parseSalaryPeriodArgs(salaryArgs);
      if (!parsed.ok) return reply(lang === 'id' ? 'Format: */rekap gaji [bulan] [tahun]*. Contoh: */rekap gaji apr 25*'
        : 'Format: */summary salary [month] [year]*. Example: */summary salary apr 25*');
      return reply(await summaryReply({action:'GET_SUMMARY',payload:{period:'salary_cycle',salary_month:parsed.month,salary_year:parsed.year}},account,lang,new Date(d.receivedAt)));
    }
    if (text === '/rekap' || text === '/summary') return reply(await summaryReply(summaryShortcutAi('this_month'),account,lang,new Date(d.receivedAt)));
    if (text === '/kategori' || text === '/categories') return reply(await categoriesReply(account,lang));
    if (text.startsWith('/cari') || text.startsWith('/search')) return reply(await searchReply(text.split(/\s+/).slice(1).join(' '),account,lang));

    let ai: AIResponse;
    if (d.repliedToId) {
      const mapping=await lookupReceipt(account.id,d.gateway,d.repliedToId);
      if (mapping.length) {
        const targetIds=mapping.flatMap(item=>item.transactionId ? [item.transactionId] : []);
        if (!targetIds.length) return reply(t[lang].resourceMissing);
        const selected=await supabase.from('transactions').select(transactionColumns+',categories(name)').eq('account_id',account.id).in('id',targetIds);
        if (selected.error || !Array.isArray(selected.data)) throw new BotWriteError('dependency');
        const transactions=selected.data.map(raw=>{
          if (!isRecord(raw)) throw new BotWriteError('dependency');
          return {txn:canonicalTxn(raw,account!.id),category:isRecord(raw.categories) && typeof raw.categories.name === 'string' ? raw.categories.name : t[lang].uncategorized};
        });
        const first=transactions.find(row=>row.txn.id===mapping[0].transactionId);
        const single:TxnForBot|undefined=mapping.length === 1 && first ? {id:first.txn.id,amount:first.txn.amount,description:first.txn.description,date:first.txn.date,category_name:first.category} : undefined;
        const context=mapping.length > 1 ? mapping.map(item=>{
          const row=transactions.find(row=>row.txn.id===item.transactionId);
          return row ? `${item.index}. ${row.txn.description} : ${row.txn.type === 'income' ? '+' : '-'}Rp${row.txn.amount} (${row.txn.date})`
            : `${item.index}. ${t[lang].resourceMissing}`;
        }).join('\n') : undefined;
        ai=validateAIResponse(await callAI(text,account,lang,single,context,new Date(d.receivedAt)));
        const ordinal=mapping.length === 1 ? mapping[0].index : ai.selection_index ?? ai.payload.selection_index;
        const target=mapping.find(item=>item.index===ordinal);
        if (!target?.transactionId) return reply(t[lang].resourceMissing);
        const current=transactions.find(row=>row.txn.id===target.transactionId)?.txn;
        if (!current) return reply(t[lang].resourceMissing);
        if (ai.action === 'DELETE_TRANSACTION' || ai.action === 'DELETE_FROM_MULTIPLE') {
          return process.env.DELETE_CONFIRMATIONS_ENABLED === 'true' ? {kind:'delete_prompt',accountId:account.id,transactionId:current.id}
            : reply(t[lang].confirmationUnsupported);
        }
        if (ai.action !== 'EDIT_TRANSACTION' && ai.action !== 'EDIT_FROM_MULTIPLE') return reply(t[lang].invalidCommand);
        const {categories,displayName}=await loadWriteContext(account,d);
        const p=ai.payload, patch:Partial<TxnInput>={};
        if (p.amount !== undefined) patch.amount=p.amount;
        if (p.type !== undefined) patch.type=p.type;
        if (p.date !== undefined) patch.date=p.date;
        if (p.description !== undefined) patch.description=p.description;
        if (Object.hasOwn(p,'category')) patch.categoryId=resolveCategory(p.category,p.type ?? current.type,categories)?.id ?? null;
        if (!Object.keys(patch).length) return reply(t[lang].invalidCommand);
        return {kind:'edit',accountId:account.id,transactionId:current.id,before:input(current),editedByName:displayName,patch};
      }
      // Legacy references without verified ordinals must not enter new-transaction classification.
      for (const column of ['wa_bot_message_id','wa_user_message_id']) {
        const legacy=await supabase.from('transactions').select('id').eq('account_id',account.id).eq(column,d.repliedToId).limit(1);
        if (legacy.error || !Array.isArray(legacy.data)) throw new BotWriteError('dependency');
        if (legacy.data.length) return reply(t[lang].resourceMissing);
      }
    }
    ai=validateAIResponse(await callAI(text,account,lang,undefined,undefined,new Date(d.receivedAt)));
    if (ai.action === 'CREATE_TRANSACTION' || ai.action === 'CREATE_MULTIPLE') {
      const {categories,displayName}=await loadWriteContext(account,d);
      const rows=(ai.action === 'CREATE_TRANSACTION' ? [ai.payload] : ai.transactions!).map(p=>createInput(p,categories));
      if (rows.length < 1 || rows.length > 100) throw new InvalidAICommand();
      return decodeCommand({kind:'create',accountId:account.id,rows,recordedByName:displayName});
    }
    if (ai.action === 'ADD_CATEGORY') return {kind:'add_category',accountId:account.id,name:ai.payload.category_name!,type:ai.payload.category_type!};
    if (ai.action === 'GET_SUMMARY') return reply(await summaryReply(ai,account,lang,new Date(d.receivedAt)));
    if (ai.action === 'GET_CATEGORIES') return reply(await categoriesReply(account,lang));
    return reply(ai.reply || t[lang].helpText);
  } catch (error) {
    if (error instanceof InvalidAICommand) return reply(t[lang].invalidCommand);
    if (error instanceof BotWriteError && error.kind !== 'dependency') return reply(error.kind === 'invalid' ? t[lang].invalidCommand
      : error.kind === 'missing' ? t[lang].resourceMissing : error.kind === 'inactive' ? t[lang].inactiveAccount : t[lang].conflict);
    throw error;
  }
}
