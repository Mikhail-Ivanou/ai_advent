export interface UserProfile {
  id: string;
  /** Short label to pick this profile from a list, e.g. "Мария (новичок)". */
  name: string;
  /** Communication style: tone, formality, mode of address. */
  style: string;
  /** Preferred response format/shape: length, structure, examples. */
  format: string;
  /** Hard constraints the assistant should always respect for this person. */
  constraints: string;
  createdAt: string;
  updatedAt: string;
}

export type UserProfileInput = Pick<UserProfile, 'name' | 'style' | 'format' | 'constraints'>;
