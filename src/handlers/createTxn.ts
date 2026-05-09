import { supabase } from '../services/supabase';
import { sendWA } from '../services/whatsapp';
import { formatIDR, formatDate } from '../utils/format';
import { Lang } from '../utils/lang';
import { t } from '../i18n/bot';
import { AIResponse, Account, IncomingMessage } from '../ai/types';
import { logger } from '../utils/logger';

export async function createTxn(
  ai: AIResponse,
  account: Account,
  msg: IncomingMessage,
  lang: Lang,
) {
  // Resolve category_id from name
  const { data: cat } = await supabase
    .from('categories')
    .select('id')
    .eq('account_id', account.id)
    .ilike('name', ai.payload.category ?? '')
    .single();

  // Look up member name by phone for attribution
  const { data: member } = await supabase
    .from('members')
    .select('display_name')
    .eq('account_id', account.id)
    .eq('wa_phone', msg.rawFrom)
    .single();

  // Insert transaction without bot message ID yet
  const { data: txn, error } = await supabase
    .from('transactions')
    .insert({
      account_id: account.id,
      category_id: cat?.id ?? null,
      amount: ai.payload.amount,
      type: ai.payload.type,
      description: ai.payload.description,
      date: ai.payload.date,
      raw_message: msg.text,
      wa_user_message_id: msg.messageId,
      recorded_by_name: member?.display_name ?? msg.rawFrom,
      recorded_by_phone: msg.rawFrom,
    })
    .select()
    .single();

  if (error || !txn) {
    logger.error('createTxn', 'insert_failed', error, {
      action: ai.action,
      amount: ai.payload.amount,
      type: ai.payload.type,
      category: ai.payload.category,
      date: ai.payload.date,
    });
    await sendWA(
      msg.chatId,
      lang === 'id'
        ? '❌ Gagal menyimpan transaksi.'
        : '❌ Failed to save transaction.',
    );
    return;
  }

  // Check budget warning — only for expense transactions with a known category
  let budgetWarning = '';
  if (ai.payload.type === 'expense' && cat?.id) {
    const { data: budget } = await supabase
      .from('budgets')
      .select('amount')
      .eq('account_id', account.id)
      .eq('category_id', cat.id)
      .single();

    if (budget) {
      // Get current month spending for this category
      const now = new Date();
      const from = new Date(now.getFullYear(), now.getMonth(), 1)
        .toISOString()
        .split('T')[0];
      const to = now.toISOString().split('T')[0];

      const { data: spendRows } = await supabase
        .from('transactions')
        .select('amount')
        .eq('account_id', account.id)
        .eq('category_id', cat.id)
        .eq('type', 'expense')
        .gte('date', from)
        .lte('date', to);

      const totalSpent = (spendRows ?? []).reduce(
        (s, r) => s + Number(r.amount),
        0,
      );
      const pct = Math.round((totalSpent / budget.amount) * 100);

      if (totalSpent > budget.amount) {
        budgetWarning =
          lang === 'id'
            ? `\n⚠️ *Budget ${ai.payload.category} terlampaui!*\nRp${formatIDR(totalSpent)} / Rp${formatIDR(budget.amount)} (${pct}%)`
            : `\n⚠️ *${ai.payload.category} budget exceeded!*\nRp${formatIDR(totalSpent)} / Rp${formatIDR(budget.amount)} (${pct}%)`;
      } else if (pct >= 80) {
        budgetWarning =
          lang === 'id'
            ? `\n⚠️ Budget ${ai.payload.category}: Rp${formatIDR(totalSpent)} / Rp${formatIDR(budget.amount)} (${pct}%)`
            : `\n⚠️ ${ai.payload.category} budget: Rp${formatIDR(totalSpent)} / Rp${formatIDR(budget.amount)} (${pct}%)`;
      }
    }
  }

  const reply =
    t[lang].txnCreated(
      ai.payload.description ?? '',
      formatIDR(ai.payload.amount ?? 0),
      ai.payload.category ?? '',
      formatDate(
        ai.payload.date ?? new Date().toISOString().split('T')[0],
        lang,
      ),
      ai.payload.type ?? 'expense',
    ) + budgetWarning;

  const botMessageId = await sendWA(msg.chatId, reply);

  // Store bot message ID so reply-to-message can look up this transaction
  await supabase
    .from('transactions')
    .update({ wa_bot_message_id: botMessageId })
    .eq('id', txn.id);
}
