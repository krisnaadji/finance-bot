// No Supabase import here — lang data is passed in by the router.
// This keeps utils free of service dependencies.
export type Lang = 'id' | 'en';
export const SUPPORTED_LANGS: Lang[] = ['id', 'en'];

// Called by router after it fetches account + member rows from Supabase.
// accountLanguage: account.language from DB
// memberLanguagePref: member.language_pref from DB (may be null)
export function resolveLang(
  accountLanguage: string,
  memberLanguagePref?: string | null,
): Lang {
  if (
    memberLanguagePref &&
    SUPPORTED_LANGS.includes(memberLanguagePref as Lang)
  )
    return memberLanguagePref as Lang;
  if (SUPPORTED_LANGS.includes(accountLanguage as Lang))
    return accountLanguage as Lang;
  return 'id';
}
