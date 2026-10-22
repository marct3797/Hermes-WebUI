/** Tastenkürzel gelten nicht, solange die Person in einem Eingabefeld tippt. */
export const isEditable = (t: EventTarget | null) => t instanceof HTMLElement && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);
