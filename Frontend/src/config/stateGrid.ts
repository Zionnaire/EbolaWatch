/**
 * Tile-grid cartogram positions for the 36 states and the FCT: each state is one equal tile, placed roughly where
 * it sits on the map (north at the top). Equal tiles stop Borno's size from drowning out Lagos. No map library.
 * Names are the backend's canonical state names.
 */
export const STATE_TILES: Record<string, { col: number; row: number; abbr: string }> = {
  Sokoto: { col: 1, row: 0, abbr: 'SO' },
  Zamfara: { col: 2, row: 0, abbr: 'ZA' },
  Katsina: { col: 3, row: 0, abbr: 'KT' },
  Kano: { col: 4, row: 0, abbr: 'KN' },
  Jigawa: { col: 5, row: 0, abbr: 'JI' },
  Yobe: { col: 6, row: 0, abbr: 'YO' },
  Borno: { col: 7, row: 0, abbr: 'BO' },
  Kebbi: { col: 0, row: 1, abbr: 'KE' },
  Niger: { col: 1, row: 1, abbr: 'NI' },
  Kaduna: { col: 3, row: 1, abbr: 'KD' },
  Bauchi: { col: 5, row: 1, abbr: 'BA' },
  Gombe: { col: 6, row: 1, abbr: 'GO' },
  Adamawa: { col: 7, row: 1, abbr: 'AD' },
  Kwara: { col: 1, row: 2, abbr: 'KW' },
  FCT: { col: 2, row: 2, abbr: 'FC' },
  Nasarawa: { col: 3, row: 2, abbr: 'NA' },
  Plateau: { col: 4, row: 2, abbr: 'PL' },
  Taraba: { col: 6, row: 2, abbr: 'TA' },
  Oyo: { col: 0, row: 3, abbr: 'OY' },
  Osun: { col: 1, row: 3, abbr: 'OS' },
  Ekiti: { col: 2, row: 3, abbr: 'EK' },
  Kogi: { col: 3, row: 3, abbr: 'KO' },
  Benue: { col: 4, row: 3, abbr: 'BE' },
  Ogun: { col: 1, row: 4, abbr: 'OG' },
  Ondo: { col: 2, row: 4, abbr: 'ON' },
  Edo: { col: 3, row: 4, abbr: 'ED' },
  Anambra: { col: 4, row: 4, abbr: 'AN' },
  Enugu: { col: 5, row: 4, abbr: 'EN' },
  Ebonyi: { col: 6, row: 4, abbr: 'EB' },
  Lagos: { col: 1, row: 5, abbr: 'LA' },
  Delta: { col: 3, row: 5, abbr: 'DE' },
  Imo: { col: 4, row: 5, abbr: 'IM' },
  Abia: { col: 5, row: 5, abbr: 'AB' },
  'Cross River': { col: 6, row: 5, abbr: 'CR' },
  Bayelsa: { col: 3, row: 6, abbr: 'BY' },
  Rivers: { col: 4, row: 6, abbr: 'RI' },
  'Akwa Ibom': { col: 5, row: 6, abbr: 'AK' },
};

export const GRID_COLS = 8;
export const GRID_ROWS = 7;
