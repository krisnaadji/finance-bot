import { supabase } from './services/supabase';
import { sendWA } from './services/whatsapp';
import { callGemini } from './ai/gemini';
import { resolveLang, SUPPORTED_LANGS, Lang } from './utils/lang';
import { isYesNo } from './utils/format';
import { t } from './i18n/bot';
import { IncomingMessage } from './ai/types';
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
} from './handlers';

// ── DB helpers ────────────────────────────────────────────────────
async function getAccountByChatId(chatId: string) {
  const { data } = await supabase
    .from('accounts')
    .select('*')
    .eq('wa_chat_id', chatId)
    .single();
  return data;
}

async function getMemberLangPref(accountId: string, waPhone: string) {
  const { data } = await supabase
    .from('members')
    .select('language_pref')
    .eq('account_id', accountId)
    .eq('wa_phone', waPhone)
    .single();
  return data?.language_pref ?? null;
}

async function getActivePending(accountId: string) {
  const { data } = await supabase
    .from('pending_actions')
    .select('*')
    .eq('account_id', accountId)
    .gt('expires_at', new Date().toISOString())
    .single();
  return data;
}

async function findTxnByReply(messageId: string, accountId: string) {
  const { data } = await supabase
    .from('transactions')
    .select('id, description, amount, date, categories(name)')
    .eq('account_id', accountId)
    .or(
      'wa_user_message_id.eq.' +
        messageId +
        ',wa_bot_message_id.eq.' +
        messageId,
    )
    .single();
  if (!data) return null;
  return {
    id: data.id as string,
    description: data.description as string,
    amount: data.amount as number,
    date: data.date as string,
    category_name: (data.categories as any)?.name ?? '',
  };
}

// ── Main router ───────────────────────────────────────────────────
export async function routeMessage(msg: IncomingMessage) {
  const text = msg.text.trim();

  // /setup is handled before account lookup — it's how accounts get linked
  if (text.startsWith('/setup')) {
    const parts = text.split(/\s+/);
    return setup(msg, parts[1] ?? '', parts[2]);
  }

  const account = await getAccountByChatId(msg.chatId);
  const dashboardUrl = process.env.DASHBOARD_URL ?? '';
  if (!account) return sendWA(msg.chatId, t['id'].notSetup(dashboardUrl));

  // Resolve language once — passed to all handlers
  const memberPref = await getMemberLangPref(account.id, msg.rawFrom);
  const lang: Lang = resolveLang(account.language, memberPref);

  // /help
  if (text === '/help') return sendWA(msg.chatId, t[lang].helpText);

  // /language id|en
  if (text.startsWith('/language')) {
    const newLang = text.split(/\s+/)[1]?.toLowerCase();
    if (!SUPPORTED_LANGS.includes(newLang as Lang))
      return sendWA(msg.chatId, 'Supported: /language id   or   /language en');
    await supabase
      .from('members')
      .upsert(
        {
          account_id: account.id,
          wa_phone: msg.rawFrom,
          language_pref: newLang,
        },
        { onConflict: 'account_id,wa_phone' },
      );
    return sendWA(msg.chatId, t[newLang as Lang].langChanged(newLang));
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

  // Pending delete confirmation: check before AI to avoid unnecessary API call
  const pending = await getActivePending(account.id);
  if (pending && isYesNo(text)) return confirmDelete(msg, pending, lang);

  // Reply to a bot message — could be single or multi-transaction
  if (msg.repliedToId) {
    // Check if multiple transactions share this message ID
    const { data: multiples } = await supabase
      .from('transactions')
      .select('*')
      .eq('account_id', account.id)
      .eq('wa_message_id', msg.repliedToId);

    if (multiples && multiples.length > 1) {
      // Build context listing all transactions for Gemini
      const context = multiples
        .map(
          (t, i) =>
            i +
            1 +
            '. ' +
            t.description +
            ' — ' +
            (t.type === 'income' ? '+' : '-') +
            'Rp' +
            t.amount +
            ' (' +
            t.date +
            ')',
        )
        .join('\n');
      const ai = await callGemini(text, account, lang, undefined, context);
      if (ai.action === 'EDIT_FROM_MULTIPLE' && ai.payload.selection_index) {
        const target = multiples[ai.payload.selection_index - 1];
        if (target) return editTxn(ai, target.id, account, msg, lang);
      }
    }

    // Single transaction reply — existing flow
    const txn = await findTxnByReply(msg.repliedToId, account.id);
    if (txn) {
      const ai = await callGemini(text, account, lang, txn);
      if (ai.action === 'EDIT_TRANSACTION')
        return editTxn(ai, txn.id, account, msg, lang);
      if (ai.action === 'DELETE_TRANSACTION')
        return deleteTxn(txn, account, msg, lang);
    }
  }

  // New message — send to AI for classification
  const ai = await callGemini(text, account, lang);
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
