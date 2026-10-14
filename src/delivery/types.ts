import { isBusinessDate, isUuid } from '../utils/financialValidation';
import type { Gateway } from '../intake/types';

export type SendOutcome =
  | { kind:'accepted'; providerMessageId:string }
  | { kind:'rejected'; retryable:boolean; code:string; retryAfterSeconds:number|null }
  | { kind:'uncertain'; code:string };
export type OutboundClaim = {
  id:string; inboxId:string; accountId:string|null; gateway:Gateway; destination:string; kind:'ordinary'|'receipt'|'help'|'confirmation';
  batchId:string|null; pendingId:string|null; expiresAt:string|null; payload:ReplySnapshot; text:string; fence:number; attemptId:string;
};
export type ReplySnapshot = {
  language:'id'|'en'; kind:'ordinary'|'receipt'|'help'|'confirmation'; code:string;
  text:string|null; rows:Array<{index:number;id:string|null;categoryId?:string|null;amount:string;type:'income'|'expense';description:string;date:string;categoryName:string|null}>;
  categoryName:string|null;categoryType:'income'|'expense'|null;accountName:string|null;
};
export function decodeReplySnapshot(value:unknown):ReplySnapshot {
  if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error('invalid_reply_snapshot');
  const row=value as Record<string,unknown>,allowed=['language','kind','code','text','rows','categoryName','categoryType','accountName'];
  if (Object.keys(row).some(key=>!allowed.includes(key))||(row.language!=='id'&&row.language!=='en')||
      !['ordinary','receipt','help','confirmation'].includes(String(row.kind))||
      typeof row.code!=='string'||!(row.text===null||typeof row.text==='string')||!Array.isArray(row.rows)||
      !(row.categoryName===null||typeof row.categoryName==='string')||
      !(row.categoryType===null||row.categoryType==='income'||row.categoryType==='expense')||
      !(row.accountName===null||typeof row.accountName==='string'))throw new Error('invalid_reply_snapshot');
  const rows=row.rows.map(item=>{
    if (!item || typeof item!=='object' || Array.isArray(item)) throw new Error('invalid_reply_snapshot');
    const r=item as Record<string,unknown>,keys=['index','id','categoryId','amount','type','description','date','categoryName'];
    if(Object.keys(r).some(key=>!keys.includes(key))||!Number.isInteger(r.index)||Number(r.index)<1||Number(r.index)>100||
      !(r.id===null||isUuid(r.id))||('categoryId' in r&&!(r.categoryId===null||isUuid(r.categoryId)))||
      typeof r.amount!=='string'||!/^(0|[1-9][0-9]{0,12})\.\d{2}$/.test(r.amount)||
      BigInt(r.amount.replace('.',''))<=0n||(r.type!=='income'&&r.type!=='expense')||
      typeof r.description!=='string'||typeof r.date!=='string'||!isBusinessDate(r.date)||
      !(r.categoryName===null||typeof r.categoryName==='string'))throw new Error('invalid_reply_snapshot');
    return {index:r.index as number,id:r.id as string|null,...('categoryId' in r?{categoryId:r.categoryId as string|null}:{}),
      amount:r.amount,type:r.type as 'income'|'expense',description:r.description,date:r.date,categoryName:r.categoryName as string|null};
  });
  if (rows.some((r,i)=>i>0&&r.index<=rows[i-1].index)) throw new Error('invalid_reply_snapshot');
  return {language:row.language,kind:row.kind as ReplySnapshot['kind'],code:row.code,text:row.text as string|null,rows,
    categoryName:row.categoryName as string|null,categoryType:row.categoryType as ReplySnapshot['categoryType'],accountName:row.accountName as string|null};
}
