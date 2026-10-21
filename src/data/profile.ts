import type { ProfileRules } from '../core/progression/profile';

// See docs/design/account.md.
export const profileRules: ProfileRules = {
  maxCharacters: 5,
  nameMinLength: 2,
  nameMaxLength: 16,
};
