/**
 * Count of Unicode code points (not UTF-16 units), so a 150-character limit
 * means what a user thinks it means for emoji and non-BMP characters.
 */
export function unicodeLength(value: string): number {
  return Array.from(value).length;
}

export function truncate(value: string, maxLength: number, ellipsis = '…'): string {
  const characters = Array.from(value);
  if (characters.length <= maxLength) return value;
  return characters.slice(0, Math.max(0, maxLength - 1)).join('') + ellipsis;
}

export function isBlank(value: string | null | undefined): boolean {
  return !value || value.trim().length === 0;
}

/** Collapse the whitespace MAX clients happily send, keep paragraph breaks. */
export function normaliseIncidentText(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
}

/**
 * Render `{{placeholder}}` slots in a category answer template.
 * Unknown placeholders are left in place so the responder can see and fill them.
 */
export function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key]! : match,
  );
}

export function pluralRu(count: number, one: string, few: string, many: string): string {
  const mod100 = Math.abs(count) % 100;
  const mod10 = mod100 % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}
