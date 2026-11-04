/** The 36 states and the FCT. Coarse location is the only location we store. */
export const NIGERIA_STATES = [
  'Abia',
  'Adamawa',
  'Akwa Ibom',
  'Anambra',
  'Bauchi',
  'Bayelsa',
  'Benue',
  'Borno',
  'Cross River',
  'Delta',
  'Ebonyi',
  'Edo',
  'Ekiti',
  'Enugu',
  'FCT',
  'Gombe',
  'Imo',
  'Jigawa',
  'Kaduna',
  'Kano',
  'Katsina',
  'Kebbi',
  'Kogi',
  'Kwara',
  'Lagos',
  'Nasarawa',
  'Niger',
  'Ogun',
  'Ondo',
  'Osun',
  'Oyo',
  'Plateau',
  'Rivers',
  'Sokoto',
  'Taraba',
  'Yobe',
  'Zamfara',
] as const;

export type NigeriaState = (typeof NIGERIA_STATES)[number];

const byLower = new Map(NIGERIA_STATES.map((s) => [s.toLowerCase(), s]));

/** Maps loose input ("lagos", "Abuja", "FCT ") onto a canonical state name; null when unrecognised. */
export function canonicalState(input: string | null | undefined): NigeriaState | null {
  if (!input) return null;
  const key = input.trim().toLowerCase();
  if (key === 'abuja' || key === 'federal capital territory') return 'FCT';
  return byLower.get(key) ?? null;
}
