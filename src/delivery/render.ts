import { t } from '../i18n/bot';
import { formatIDR, formatDate } from '../utils/format';
import type { Lang } from '../utils/lang';
import { decodeReplySnapshot, type ReplySnapshot } from './types';

function cents(amount:string):bigint{const [whole,fraction]=amount.split('.');return BigInt(whole)*100n+BigInt(fraction);}
export function renderReply(value:ReplySnapshot):string{
  const s=decodeReplySnapshot(value),lang=s.language as Lang,words=t[lang];
  if(s.text!==null)return s.text;
  if(s.code==='setup_ok')return words.setupOk(s.accountName??'');
  if(s.code==='setup_bad_code')return words.setupBadCode(process.env.DASHBOARD_URL??'');
  if(s.code==='language_changed')return words.langChanged(lang);
  if(s.code==='category_added')return words.categoryAdded(s.categoryName??'',s.categoryType??'expense');
  if(s.code==='deleted')return words.txnDeleted;
  if(s.code==='cancelled')return words.txnDeleteCancel;
  if(s.code==='delete_prompt'){
    const row=s.rows[0];if(!row)throw new Error('invalid_confirmation_snapshot');
    return words.deleteConfirm(row.description,formatIDR(row.amount),row.categoryName??words.uncategorized,formatDate(row.date,lang));
  }
  if(s.code==='created'||s.code==='edited'){
    if(!s.rows.length)throw new Error('invalid_receipt_snapshot');
    const lines=s.rows.map(row=>{
      const receipt=words.txnCreated(row.description,formatIDR(row.amount),row.categoryName??words.uncategorized,formatDate(row.date,lang),row.type);
      return s.rows.length===1?(s.code==='edited'?words.txnEdited+'\n'+receipt:receipt):`${row.index}. ${receipt.split('\n\n')[0]}`;
    });
    if(s.rows.length===1)return lines[0];
    const sum=s.rows.reduce((total,row)=>total+(row.type==='expense'?cents(row.amount):-cents(row.amount)),0n);
    const abs=sum<0n?-sum:sum,total=`${abs/100n}.${String(abs%100n).padStart(2,'0')}`;
    const heading=lang==='id'?`✅ *${s.rows.length} transaksi tercatat!*`:`✅ *${s.rows.length} transactions recorded!*`;
    return `${heading}\n\n${lines.join('\n\n')}\n\n🏦 Total: ${sum>=0n?'-':'+'}Rp${formatIDR(total)}`;
  }
  if(s.code==='reply')throw new Error('reply snapshot missing text');
  if(s.code==='invalid')return words.invalidCommand;
  if(s.code==='missing'||s.code==='target_missing')return words.resourceMissing;
  if(s.code==='inactive')return words.inactiveAccount;
  if(s.code==='conflict')return words.conflict;
  if(s.code==='forbidden')return words.confirmationUnsupported;
  if(s.code==='expired')return words.confirmationExpired;
  if(s.code==='already_consumed')return words.confirmationHandled;
  return words.dependencyUnavailable;
}
