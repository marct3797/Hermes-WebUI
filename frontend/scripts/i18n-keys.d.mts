export const LOCALES: string;
export function collectKeys(): string[];
export function placeholders(s: string): string;
export function checkLocale(id: string, keys?: string[]): { missing: string[]; extra: string[]; badPlaceholders: string[]; empty: string[]; same: string[] };
