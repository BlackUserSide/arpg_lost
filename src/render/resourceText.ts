import { t, tx, type MessageKey } from '../i18n';

// Display names of class resources (ClassDef.resource.id), from the locale files (`resource.<id>.<form>`).
// Forms exist because some languages inflect: Ukrainian "Лють" / "+10 люті" / "за 1 лють".

/** name: capitalised nominative ("Rage", "Лють"); gen: after a number or "of" ("люті"); acc: object ("лють"). */
export type ResourceForm = 'name' | 'gen' | 'acc';

const GENERIC: Readonly<Record<ResourceForm, MessageKey>> = {
  name: 'resource.generic.name',
  gen: 'resource.generic.gen',
  acc: 'resource.generic.acc',
};

/** The resource's name in the current locale; neutral wording ("Resource") for an unknown or missing id. */
export function resourceText(id: string | undefined, form: ResourceForm = 'name'): string {
  const own = id !== undefined ? tx(`resource.${id}.${form}`, undefined, '') : '';
  return own || t(GENERIC[form]);
}

/** Displayed resource cost: costs can be fractional (×1.3 × 1.4), shown as a whole number, never 0 for a real cost. */
export function formatCost(amount: number): string {
  if (amount <= 0) return '0';
  return String(Math.max(1, Math.round(amount)));
}
