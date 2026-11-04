import { GRID_COLS, GRID_ROWS, STATE_TILES } from '@/config/stateGrid';
import type { GeoState } from '@/contracts';

const TILE = 74;
const GAP = 6;

/** Light paper -> blush -> clay as density rises. Text flips to white once the fill is dark enough to need it. */
export function fillFor(density: number): { bg: string; fg: string } {
  const stops = [
    [241, 232, 211],
    [231, 179, 164],
    [168, 65, 44],
  ] as const;
  const t = Math.max(0, Math.min(1, density)) * 2;
  const i = Math.min(1, Math.floor(t));
  const f = t - i;
  const a = stops[i]!;
  const b = stops[i + 1]!;
  const rgb = a.map((v, k) => Math.round(v + (b[k]! - v) * f));
  return { bg: `rgb(${rgb.join(',')})`, fg: density > 0.5 ? '#fff' : '#22302d' };
}

interface Props {
  states: GeoState[];
  selected?: string | null;
  onSelect: (state: string) => void;
  /** Smaller tiles for a summary view: abbreviations and counts only on tiles that have activity. */
  compact?: boolean;
}

/**
 * Tile-grid cartogram of the 36 states and the FCT: one equal tile each, coloured by flagged-post density, with a
 * triangle on any state that is surging (so surge is never colour alone). Keyboard and screen-reader friendly.
 */
export function Cartogram({ states, selected, onSelect, compact }: Props) {
  const byName = new Map(states.map((s) => [s.state, s]));
  return (
    <svg
      className="cartogram"
      viewBox={`0 0 ${GRID_COLS * (TILE + GAP)} ${GRID_ROWS * (TILE + GAP)}`}
      role="group"
      aria-label="Cartogram of Nigerian states coloured by number of flagged posts"
    >
      {Object.entries(STATE_TILES).map(([name, pos]) => {
        const s = byName.get(name);
        const { bg, fg } = fillFor(s?.density ?? 0);
        const on = selected === name;
        const select = () => onSelect(name);
        const active = (s?.flagged ?? 0) > 0;
        return (
          <g
            key={name}
            className={`tile ${on ? 'is-selected' : ''}`}
            transform={`translate(${pos.col * (TILE + GAP)} ${pos.row * (TILE + GAP)})`}
            role="button"
            tabIndex={0}
            aria-pressed={on}
            aria-label={`${name}: ${s?.flagged ?? 0} flagged posts${s?.surge ? ', surging' : ''}`}
            onClick={select}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                select();
              }
            }}
          >
            <rect width={TILE} height={TILE} rx={12} fill={bg} />
            <text
              x={9}
              y={compact ? 28 : 22}
              fontSize={compact ? 17 : 13}
              fill={fg}
              opacity={compact && !active ? 0.45 : 0.85}
            >
              {pos.abbr}
            </text>
            {(!compact || active) && (
              <text
                x={9}
                y={TILE - 12}
                fontSize={compact ? 24 : 22}
                fill={fg}
                opacity={active ? 1 : 0.4}
                style={{ fontFamily: 'var(--font-display)' }}
              >
                {s?.flagged ?? 0}
              </text>
            )}
            {s?.surge && (
              <path
                d={`M${TILE - 22} 12 l8 -14 l8 14 z`}
                transform="translate(2 8)"
                fill="#22302d"
                stroke="#fffaf0"
                strokeWidth={1.5}
                strokeLinejoin="round"
              />
            )}
          </g>
        );
      })}
    </svg>
  );
}

export function MapLegend() {
  return (
    <div className="row small muted" style={{ gap: 14 }}>
      <span className="row" style={{ gap: 6 }}>
        Fewer
        <span
          style={{
            width: 120,
            height: 10,
            borderRadius: 6,
            background: `linear-gradient(90deg, ${fillFor(0).bg}, ${fillFor(0.5).bg}, ${fillFor(1).bg})`,
          }}
        />
        More
      </span>
      <span className="row" style={{ gap: 6 }}>
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M8 1.500 15 14H1Z" fill="#22302d" />
        </svg>
        Surging
      </span>
    </div>
  );
}
