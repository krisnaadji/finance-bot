import { supabase } from './services/supabase';
import { sendWA } from './services/whatsapp';
import { callAI } from './ai';
import { logger } from './utils/logger';
import { resolveLang, SUPPORTED_LANGS, Lang } from './utils/lang';
import { isYesNo } from './utils/format';
import { t } from './i18n/bot';
import { IncomingMessage, AIResponse, Account, PendingAction, TxnForBot } from './ai/types';
import { isRecord, isUuid } from './utils/financialValidation';
import { validateAIResponse, InvalidAICommand } from './ai/validation';
import { BotWriteError, BotDeliveryError, assertActiveLinkedAccount, canonicalTxn, transactionColumns } from './handlers/transactionData';
import {
  helpShortcutHint,
  resolveHelpShortcut,
  sendHelp,
  summaryShortcutAi,
} from './handlers/helpMenu';
import { parseSalaryPeriodArgs } from './handlers/salaryPeriodArgs';
import {
  createTxn,
  createMultiple,
  editTxn,
  deleteTxn,
  confirmDelete,
  getSummary,
  getCategories,
  addCategory,
  chitchat,
  setup,
  searchTxn,
} from './handlers';

// ── DB helpers ────────────────────────────────────────────────────
async function getAccountByChatId(chatId: string): Promise<Account | null> {
  const result = await supabase.from('accounts').select('*').eq('wa_chat_id', chatId).eq('is_active', true).maybeSingle();
  if (result.error) throw new BotWriteError('dependency');
  if (!result.data) return null;
  const row: unknown = result.data;
  if (!isRecord(row) || !isUuid(row.id) || !isUuid(row.owner_id) || typeof row.name !== 'string' ||
      (row.type !== 'personal' && row.type !== 'group') || typeof row.language !== 'string' ||
      row.wa_chat_id !== chatId || row.is_active !== true) throw new BotWriteError('dependency');
  return { id: row.id, owner_id: row.owner_id, name: row.name, type: row.type,
    language: row.language, wa_chat_id: chatId, is_active: true };
}

async function getMemberLangPref(accountId: string, waPhone: string): Promise<string | null> {
  const result = await supabase.from('members').select('language_pref').eq('account_id', accountId).eq('wa_phone', waPhone).maybeSingle();
  if (result.error) throw new BotWriteError('dependency');
  return typeof result.data?.language_pref === 'string' ? result.data.language_pref : null;
}

async function getPendingForReply(accountId: string, chatId: string, confirmationMessageId: string | null, requesterPhone?: string): Promise<PendingAction | null> {
  let query = supabase.from('pending_actions').select('*').eq('account_id', accountId).eq('wa_chat_id', chatId);
  if (requesterPhone !== undefined) query = query.eq('requested_by_phone', requesterPhone);
  if (confirmationMessageId !== null) query = query.eq('confirmation_message_id', confirmationMessageId);
  else if (requesterPhone !== undefined) query = query.eq('action', 'DELETE');
  else return null;
  const result = await query.maybeSingle();
  if (result.error) throw new BotWriteError('dependency');
  if (!result.data) return null;
  const value: unknown = result.data;
  if (isRecord(value) && value.confirmation_message_id === null) return null;
  if (!isRecord(value) || !isUuid(value.id) || !isUuid(value.transaction_id) || value.account_id !== accountId ||
      value.wa_chat_id !== chatId || value.action !== 'DELETE' ||
      typeof value.confirmation_message_id !== 'string' || !value.confirmation_message_id ||
      (confirmationMessageId !== null && value.confirmation_message_id !== confirmationMessageId) ||
      (requesterPhone !== undefined && value.requested_by_phone !== requesterPhone) ||
      typeof value.requested_by_phone !== 'string' || typeof value.expires_at !== 'string') throw new BotWriteError('dependency');
  return { id: value.id, transaction_id: value.transaction_id, account_id: accountId, action: 'DELETE',
    wa_chat_id: chatId, requested_by_phone: value.requested_by_phone,
    expires_at: value.expires_at, confirmation_message_id: value.confirmation_message_id };
}

async function findTxnByReply(messageId: string, accountId: string): Promise<TxnForBot | null> {
  for (const column of ['wa_bot_message_id', 'wa_user_message_id']) {
    const result = await supabase.from('transactions').select(transactionColumns + ',categories(name)')
      .eq('account_id', accountId).eq(column, messageId).maybeSingle();
    if (result.error) throw new BotWriteError('dependency');
    if (result.data) {
      const raw: unknown = result.data;
      const txn = canonicalTxn(raw, accountId);
      const category = isRecord(raw) && isRecord(raw.categories) ? raw.categories : null;
      return { id: txn.id, description: txn.description, amount: txn.amount, date: txn.date,
        category_name: typeof category?.name === 'string' ? category.name : '' };
    }
  }
  return null;
}

async function checkedAI(...args: Parameters<typeof callAI>): Promise<AIResponse> {
  return validateAIResponse(await callAI(...args));
}

// ── Main router ───────────────────────────────────────────────────
async function routeMessageInner(msg: IncomingMessage, setLang: (lang: Lang) => void) {
  const text = msg.text.trim();

  // /setup is handled before account lookup — it's how accounts get linked
  if (text.startsWith('/setup')) {
    const parts = text.split(/\s+/);
    if (SUPPORTED_LANGS.includes(parts[2] as Lang)) setLang(parts[2] as Lang);
    return setup(msg, parts[1] ?? '', parts[2]);
  }

  const account = await getAccountByChatId(msg.chatId);
  const dashboardUrl = process.env.DASHBOARD_URL ?? '';
  if (!account) return sendWA(msg.chatId, t['id'].notSetup(dashboardUrl));

  // Resolve language once — passed to all handlers
  setLang(resolveLang(account.language, null));
  const memberPref = await getMemberLangPref(account.id, msg.rawFrom);
  const lang: Lang = resolveLang(account.language, memberPref);
  setLang(lang);

  // Reserve all yes/no messages for explicit confirmation, never AI financial classification.
  if (isYesNo(text)) {
    if (process.env.DELETE_CONFIRMATIONS_ENABLED !== 'true')
      return sendWA(msg.chatId, t[lang].confirmationUnsupported);
    const pending = await getPendingForReply(account.id, msg.chatId, msg.repliedToId, msg.rawFrom);
    if (!pending || pending.requested_by_phone !== msg.rawFrom)
      return sendWA(msg.chatId, t[lang].confirmationUnsupported);
    return confirmDelete(msg, pending, account, lang);
  }
  if (msg.repliedToId) {
    const pending = await getPendingForReply(account.id, msg.chatId, msg.repliedToId);
    if (pending) return sendWA(msg.chatId, t[lang].confirmationUnsupported);
  }

  // /help
  if (text === '/help') return sendHelp(msg, lang);

  // /language id|en
  if (text.startsWith('/language')) {
    const newLang = text.split(/\s+/)[1]?.toLowerCase();
    if (!SUPPORTED_LANGS.includes(newLang as Lang))
      return sendWA(msg.chatId, 'Supported: /language id   or   /language en');
    await assertActiveLinkedAccount(account, msg);
    const member = await supabase.from('members').select('id')
      .eq('account_id', account.id).eq('wa_phone', msg.rawFrom).maybeSingle();
    if (member.error) throw new BotWriteError('dependency');
    if (member.data && !isUuid(member.data.id)) throw new BotWriteError('dependency');
    const write = member.data
      ? supabase.from('members').update({ language_pref: newLang })
        .eq('id', member.data.id).eq('account_id', account.id).eq('wa_phone', msg.rawFrom)
      : supabase.from('members').insert({ account_id: account.id, wa_phone: msg.rawFrom, language_pref: newLang });
    const result = await write.select('account_id,wa_phone,language_pref').single();
    if (result.error) throw new BotWriteError('dependency');
    if (!result.data || result.data.account_id !== account.id || result.data.wa_phone !== msg.rawFrom || result.data.language_pref !== newLang)
      throw new BotWriteError('missing');
    try { return await sendWA(msg.chatId, t[newLang as Lang].langChanged(result.data.language_pref)); }
    catch { throw new BotDeliveryError(); }
  }

  // /dashboard — send dashboard link
  if (text === '/dashboard') {
    const url = process.env.DASHBOARD_URL ?? 'Not configured';
    const reply =
      lang === 'id'
        ? '📱 *Dashboard Finance Bot*\n\n' +
          url +
          '\n\nLihat ringkasan, transaksi, dan kelola akun di sini.'
        : '📱 *Finance Bot Dashboard*\n\n' +
          url +
          '\n\nView summaries, transactions, and manage your account here.';
    return sendWA(msg.chatId, reply);
  }

  const helpShortcut = resolveHelpShortcut(msg);
  if (helpShortcut === 'summary') {
    return getSummary(summaryShortcutAi('this_month'), account, msg, lang);
  }
  if (helpShortcut === 'salary_summary') {
    return getSummary(summaryShortcutAi('salary_cycle'), account, msg, lang);
  }
  if (helpShortcut === 'categories') return getCategories(account, msg, lang);
  if (helpShortcut === 'dashboard') {
    const url = process.env.DASHBOARD_URL ?? 'Not configured';
    const reply =
      lang === 'id'
        ? '📱 *Dashboard Finance Bot*\n\n' +
          url +
          '\n\nLihat ringkasan, transaksi, dan kelola akun di sini.'
        : '📱 *Finance Bot Dashboard*\n\n' +
          url +
          '\n\nView summaries, transactions, and manage your account here.';
    return sendWA(msg.chatId, reply);
  }
  if (
    helpShortcut === 'search_hint' ||
    helpShortcut === 'language_hint' ||
    helpShortcut === 'setup_hint'
  ) {
    return sendWA(msg.chatId, helpShortcutHint(helpShortcut, lang));
  }

  const salarySummaryArgs =
    text === '/rekap gaji'
      ? ''
      : text.startsWith('/rekap gaji ')
        ? text.slice('/rekap gaji'.length)
        : text === '/summary salary'
          ? ''
          : text.startsWith('/summary salary ')
            ? text.slice('/summary salary'.length)
            : null;

  // /rekap gaji or /summary salary shortcut
  if (salarySummaryArgs !== null) {
    const args = salarySummaryArgs;
    const parsed = parseSalaryPeriodArgs(args);

    if (!parsed.ok) {
      return sendWA(
        msg.chatId,
        lang === 'id'
          ? 'Format: */rekap gaji [bulan] [tahun]*. Contoh: */rekap gaji apr 25*'
          : 'Format: */summary salary [month] [year]*. Example: */summary salary apr 25*',
      );
    }

    return getSummary(
      {
        action: 'GET_SUMMARY',
        payload: {
          period: 'salary_cycle',
          salary_month: parsed.month,
          salary_year: parsed.year,
        },
      },
      account,
      msg,
      lang,
    );
  }

  // /rekap or /summary shortcut
  if (text === '/rekap' || text === '/summary')
    return getSummary(
      { action: 'GET_SUMMARY', payload: { period: 'this_month' } },
      account,
      msg,
      lang,
    );

  // /kategori or /categories shortcut
  if (text === '/kategori' || text === '/categories')
    return getCategories(account, msg, lang);

  // /cari [query] — search transactions
  if (text.startsWith('/cari') || text.startsWith('/search')) {
    const query = text.split(/\s+/).slice(1).join(' ');
    return searchTxn(query, account, msg, lang);
  }

  // Reply to a bot message — could be single or multi-transaction
  if (msg.repliedToId) {
    // Check if multiple transactions share this message ID
    const { data: multiples, error: multipleError } = await supabase
      .from('transactions')
      .select('*, categories(name)')
      .eq('account_id', account.id)
      .eq('wa_bot_message_id', msg.repliedToId)
      .order('created_at');
    if (multipleError || !Array.isArray(multiples)) throw new BotWriteError('dependency');
    for (const row of multiples) canonicalTxn(row, account.id);

    logger.debug('router', 'reply_lookup', {
      messageId: msg.repliedToId,
      matches: multiples?.length ?? 0,
    });

    if (multiples && multiples.length > 1) {
      const context = multiples
        .map(
          (t, i) =>
            i +
            1 +
            '. ' +
            t.description +
            ' : ' +
            (t.type === 'income' ? '+' : '-') +
            'Rp' +
            t.amount +
            ' (' +
            t.date +
            ')',
        )
        .join('\n');

      const ai = await checkedAI(text, account, lang, undefined, context);
      const selIdx = ai.selection_index ?? ai.payload.selection_index;

      // Handle edit — accept both EDIT_FROM_MULTIPLE and EDIT_TRANSACTION
      const isEdit =
        ai.action === 'EDIT_FROM_MULTIPLE' || ai.action === 'EDIT_TRANSACTION';
      if (isEdit && selIdx) {
        const target = multiples[selIdx - 1];
        if (target) return editTxn(ai, target.id, account, msg, lang);
      }

      // Handle delete — accept both DELETE_FROM_MULTIPLE and DELETE_TRANSACTION
      const isDelete =
        ai.action === 'DELETE_FROM_MULTIPLE' ||
        ai.action === 'DELETE_TRANSACTION';
      if (isDelete && selIdx) {
        const raw = multiples[selIdx - 1];
        if (raw) {
          const txn = {
            ...raw,
            category_name: (raw.categories as { name?: string } | null)?.name ?? t[lang].uncategorized,
          };
          return deleteTxn(txn, account, msg, lang);
        }
      }
      return sendWA(msg.chatId, t[lang].invalidCommand);
    }

    // Single transaction reply — existing flow
    const txn = await findTxnByReply(msg.repliedToId, account.id);
    if (txn) {
      const ai = await checkedAI(text, account, lang, txn);
      if (ai.action === 'EDIT_TRANSACTION')
        return editTxn(ai, txn.id, account, msg, lang);
      if (ai.action === 'DELETE_TRANSACTION')
        return deleteTxn(txn, account, msg, lang);
      return sendWA(msg.chatId, t[lang].invalidCommand);
    }
  }

  // New message — send to AI for classification
  const ai = await checkedAI(text, account, lang);
  switch (ai.action) {
    case 'CREATE_TRANSACTION':
      return createTxn(ai, account, msg, lang);
    case 'CREATE_MULTIPLE':
      return createMultiple(ai, account, msg, lang);
    case 'GET_SUMMARY':
      return getSummary(ai, account, msg, lang);
    case 'GET_CATEGORIES':
      return getCategories(account, msg, lang);
    case 'ADD_CATEGORY':
      return addCategory(ai, account, msg, lang);
    default:
      return chitchat(ai, account, msg, lang);
  }
}

export async function routeMessage(msg: IncomingMessage) {
  let lang: Lang = 'id';
  try { return await routeMessageInner(msg, (resolved) => { lang = resolved; }); }
  catch (error) {
    if (error instanceof BotDeliveryError) throw error;
    if (error instanceof InvalidAICommand) return sendWA(msg.chatId, t[lang].invalidCommand);
    if (error instanceof BotWriteError) {
      const message = error.kind === 'invalid' ? t[lang].invalidCommand : error.kind === 'missing' ? t[lang].resourceMissing :
        error.kind === 'conflict' ? t[lang].conflict : error.kind === 'inactive' ? t[lang].inactiveAccount : t[lang].dependencyUnavailable;
      return sendWA(msg.chatId, message);
    }
    throw error;
  }
}
