// Display names of class resources (ClassDef.resource.id), in one place so the future i18n file can take them over.
// Each screen keeps its current language: English for HUD / inventory / run, Ukrainian for the passive tree.

export interface ResourceNames {
  /** English, capitalised: "Rage". */
  readonly en: string;
  /** Ukrainian nominative: "Лють". */
  readonly uk: string;
  /** Ukrainian genitive: "люті" ("+10 люті", "замість люті"). */
  readonly ukGen: string;
  /** Ukrainian accusative: "лють" ("за 1 лють"). */
  readonly ukAcc: string;
}

const RESOURCE_NAMES: Readonly<Record<string, ResourceNames>> = {
  rage: { en: 'Rage', uk: 'Лють', ukGen: 'люті', ukAcc: 'лють' },
  energy: { en: 'Energy', uk: 'Енергія', ukGen: 'енергії', ukAcc: 'енергію' },
  mana: { en: 'Mana', uk: 'Мана', ukGen: 'мани', ukAcc: 'ману' },
};

/** Neutral wording when the hero (and so the resource) is unknown, or for an id without a name yet. */
export const GENERIC_RESOURCE: ResourceNames = { en: 'Resource', uk: 'Ресурс', ukGen: 'ресурсу', ukAcc: 'од. ресурсу' };

export function resourceNames(id: string | undefined): ResourceNames {
  return (id !== undefined ? RESOURCE_NAMES[id] : undefined) ?? GENERIC_RESOURCE;
}
