import { isRecord, isUuid } from './utils/financialValidation';

export type CategoryType = 'income' | 'expense';
export type CategoryLocale = 'id' | 'en';
export interface Category {
  id: string; account_id: string; code: string | null; name_id: string | null; name_en: string | null;
  parent_id: string | null; type: CategoryType; is_custom: boolean; is_active: boolean; sort_order: number;
}
export const categoryColumns = 'id,account_id,code,name_id,name_en,parent_id,type,is_custom,is_active,sort_order';
export function decodeCategory(value: unknown, accountId?: string): Category {
  if (!isRecord(value) || !isUuid(value.id) || !isUuid(value.account_id) || (accountId !== undefined && value.account_id !== accountId) ||
      (value.code !== null && typeof value.code !== 'string') ||
      (value.name_id !== null && typeof value.name_id !== 'string') || (value.name_en !== null && typeof value.name_en !== 'string') ||
      !(typeof value.name_id === 'string' && value.name_id.trim() || typeof value.name_en === 'string' && value.name_en.trim()) ||
      (value.parent_id !== null && !isUuid(value.parent_id)) || (value.type !== 'income' && value.type !== 'expense') ||
      typeof value.is_custom !== 'boolean' || typeof value.is_active !== 'boolean' || !Number.isSafeInteger(value.sort_order)) throw new Error('Invalid category');
  return {id:value.id,account_id:value.account_id,code:value.code as string|null,name_id:value.name_id as string|null,
    name_en:value.name_en as string|null,parent_id:value.parent_id as string|null,type:value.type,is_custom:value.is_custom,
    is_active:value.is_active,sort_order:value.sort_order as number};
}
export function categoryLabel(c: Pick<Category,'name_id'|'name_en'>, locale: CategoryLocale): string {
  const label = locale === 'en' ? c.name_en?.trim() || c.name_id?.trim() : c.name_id?.trim() || c.name_en?.trim();
  if (!label) throw new Error('Missing category label');
  return label;
}
function root(c: Category, byId: ReadonlyMap<string, Category>): Category {
  if (c.parent_id === null) return c;
  const parent = byId.get(c.parent_id);
  if (!parent || parent.id === c.id || parent.account_id !== c.account_id || parent.type !== c.type || parent.parent_id !== null || parent.code === 'salary') throw new Error('Invalid category parent');
  return parent;
}
export function categoryRoot(c: Category, categories: readonly Category[]): Category {
  return root(c, new Map(categories.map(row => [row.id,row])));
}
export function categoryPath(c: Category, categories: readonly Category[], locale: CategoryLocale): string {
  const parent = categoryRoot(c,categories);
  return parent.id === c.id ? categoryLabel(c,locale) : `${categoryLabel(parent,locale)} / ${categoryLabel(c,locale)}`;
}
export function selectableCategories(categories: readonly Category[], type: CategoryType): Category[] {
  const byId = new Map(categories.map(c => [c.id,c]));
  return categories.filter(c => c.type === type && c.is_active && root(c,byId).is_active);
}
export function resolveCategoryId(id: string | null | undefined, type: CategoryType, categories: readonly Category[]): Category | null {
  if (id === null || id === undefined) return null;
  const c = categories.find(row => row.id === id);
  if (!c || c.type !== type || !c.is_active || !categoryRoot(c,categories).is_active) throw new Error('Invalid category selection');
  return c;
}
