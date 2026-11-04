import type { CSSProperties } from 'react';

/**
 * Illustrations are drawn in code from a small botanical vocabulary (a leaf, a stem, a bloom), so every scene
 * shares one hand: pointed leaves with a midrib, soft hills, a magnifying lens as the "watching" motif.
 * They are decorative (aria-hidden) and take their colours from the theme tokens.
 */

interface LeafProps {
  x: number;
  y: number;
  /** length in px */
  len?: number;
  /** degrees; 0 points right */
  rot?: number;
  fill?: string;
  vein?: string;
  flip?: boolean;
  opacity?: number;
}

/** A pointed leaf with a midrib, base at (x, y). */
export function Leaf({
  x,
  y,
  len = 56,
  rot = 0,
  fill = 'var(--forest-500)',
  vein = 'rgba(255,255,255,.45)',
  flip,
  opacity = 1,
}: LeafProps) {
  const w = len * 0.3;
  const sy = flip ? -1 : 1;
  return (
    <g transform={`translate(${x} ${y}) rotate(${rot}) scale(1 ${sy})`} opacity={opacity}>
      <path
        d={`M0 0C${len * 0.22} ${-w} ${len * 0.68} ${-w * 1.05} ${len} 0C${len * 0.68} ${w * 0.95} ${len * 0.22} ${w} 0 0Z`}
        fill={fill}
      />
      <path
        d={`M2 0C${len * 0.35} ${-1} ${len * 0.7} ${-0.5} ${len * 0.93} 0`}
        fill="none"
        stroke={vein}
        strokeWidth={1.4}
        strokeLinecap="round"
      />
      <path
        d={`M${len * 0.3} 0l${len * 0.14} ${-w * 0.45}M${len * 0.3} 0l${len * 0.14} ${w * 0.4}M${len * 0.52} 0l${len * 0.12} ${-w * 0.38}M${len * 0.52} 0l${len * 0.12} ${w * 0.34}`}
        fill="none"
        stroke={vein}
        strokeWidth={1}
        strokeLinecap="round"
      />
    </g>
  );
}

interface SprigProps {
  /** base point */
  x: number;
  y: number;
  /** stem length */
  h?: number;
  /** lean in px at the tip (negative leans left) */
  lean?: number;
  leaves?: number;
  leaf?: number;
  fill?: string;
  stem?: string;
}

/** A curved stem with leaves alternating up its length. */
export function Sprig({
  x,
  y,
  h = 140,
  lean = 20,
  leaves = 5,
  leaf = 44,
  fill = 'var(--forest-500)',
  stem = 'var(--forest-300)',
}: SprigProps) {
  const cx = x + lean * 0.2;
  const cy = y - h * 0.55;
  const ex = x + lean;
  const ey = y - h;
  const point = (t: number) => {
    const u = 1 - t;
    return { x: u * u * x + 2 * u * t * cx + t * t * ex, y: u * u * y + 2 * u * t * cy + t * t * ey };
  };
  return (
    <g>
      <path
        d={`M${x} ${y}Q${cx} ${cy} ${ex} ${ey}`}
        fill="none"
        stroke={stem}
        strokeWidth={2.4}
        strokeLinecap="round"
      />
      {Array.from({ length: leaves }, (_, i) => {
        const t = 0.22 + (i / leaves) * 0.7;
        const p = point(t);
        const side = i % 2 === 0 ? -1 : 1;
        return (
          <Leaf
            key={i}
            x={p.x}
            y={p.y}
            len={leaf * (1.05 - t * 0.35)}
            rot={-90 + side * 52 + lean * 0.4}
            fill={fill}
            flip={side > 0}
          />
        );
      })}
      <Leaf x={ex} y={ey} len={leaf * 0.8} rot={-90 + lean * 0.5} fill={fill} />
    </g>
  );
}

/** Small round bloom: five petals around a core. */
function Bloom({
  x,
  y,
  r = 10,
  petal = 'var(--blush-400)',
  core = 'var(--ochre)',
}: {
  x: number;
  y: number;
  r?: number;
  petal?: string;
  core?: string;
}) {
  return (
    <g transform={`translate(${x} ${y})`}>
      {[0, 72, 144, 216, 288].map((a) => (
        <ellipse
          key={a}
          cx={0}
          cy={-r * 0.9}
          rx={r * 0.55}
          ry={r * 0.95}
          fill={petal}
          transform={`rotate(${a})`}
        />
      ))}
      <circle r={r * 0.42} fill={core} />
    </g>
  );
}

/** The product mark: a leaf with a midrib inside a rounded forest square. */
export function BrandMark({ size = 38 }: { size?: number }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true" className="brand__mark">
      <rect width="32" height="32" rx="9" fill="var(--forest-700)" />
      <path
        d="M16 5c5.500 3.200 8 8.200 6.200 13.600C20.800 22.600 18 25 16 27c-2-2-4.800-4.400-6.200-8.400C8 13.200 10.500 8.200 16 5Z"
        fill="var(--blush-200)"
      />
      <path
        d="M16 9v16M16 14l-3.400-2.200M16 18.500l3.600-2.400"
        stroke="var(--forest-900)"
        strokeWidth={1.6}
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

/** Bottom of the sidebar: a low planting of sprigs on a dark hill. */
export function SidebarGarden() {
  return (
    <svg
      className="sidebar__art"
      viewBox="0 0 252 190"
      aria-hidden="true"
      preserveAspectRatio="xMidYMax slice"
    >
      <path
        d="M0 150C50 128 100 160 160 140S230 128 252 142V190H0Z"
        fill="var(--forest-950)"
        opacity={0.55}
      />
      <Sprig
        x={34}
        y={190}
        h={118}
        lean={-14}
        leaves={5}
        leaf={40}
        fill="var(--forest-700)"
        stem="var(--forest-500)"
      />
      <Sprig
        x={92}
        y={190}
        h={84}
        lean={12}
        leaves={4}
        leaf={34}
        fill="var(--forest-500)"
        stem="var(--forest-300)"
      />
      <Sprig
        x={168}
        y={190}
        h={132}
        lean={16}
        leaves={6}
        leaf={42}
        fill="var(--forest-700)"
        stem="var(--forest-500)"
      />
      <Sprig
        x={222}
        y={190}
        h={92}
        lean={-12}
        leaves={4}
        leaf={36}
        fill="var(--forest-500)"
        stem="var(--forest-300)"
      />
      <Bloom x={162} y={52} r={9} />
      <Bloom x={30} y={78} r={7} petal="var(--blush-200)" />
    </svg>
  );
}

/** Corner foliage for hero cards. `side` picks the corner. */
export function CardLeaves({
  side = 'right',
  tone = 'dark',
  style,
}: {
  side?: 'right' | 'left';
  tone?: 'dark' | 'blush';
  style?: CSSProperties;
}) {
  const a = tone === 'dark' ? 'var(--forest-700)' : 'var(--blush-400)';
  const b = tone === 'dark' ? 'var(--forest-500)' : 'var(--blush-600)';
  const stem = tone === 'dark' ? 'var(--forest-300)' : 'var(--blush-600)';
  return (
    <svg
      className="card__art"
      viewBox="0 0 170 150"
      width={170}
      height={150}
      aria-hidden="true"
      style={{ [side]: -6, bottom: -6, transform: side === 'left' ? 'scaleX(-1)' : undefined, ...style }}
    >
      <Sprig x={130} y={158} h={130} lean={-26} leaves={5} leaf={40} fill={a} stem={stem} />
      <Sprig x={86} y={160} h={88} lean={-10} leaves={4} leaf={32} fill={b} stem={stem} />
      <Leaf x={150} y={150} len={46} rot={-130} fill={b} />
    </svg>
  );
}

/** The sign-in scene: rolling hills, a tall plant and a magnifying lens held over the leaves. */
export function WatchScene() {
  return (
    <svg
      className="auth__scene"
      viewBox="0 0 600 380"
      preserveAspectRatio="xMidYMax slice"
      aria-hidden="true"
    >
      <circle cx="470" cy="90" r="46" fill="var(--blush-200)" opacity={0.9} />
      <path d="M0 250C90 205 170 240 260 222S430 190 600 238V380H0Z" fill="var(--forest-800)" />
      <path
        d="M0 300C110 262 200 300 300 282S470 262 600 296V380H0Z"
        fill="var(--forest-950)"
        opacity={0.7}
      />
      <Sprig
        x={70}
        y={380}
        h={220}
        lean={26}
        leaves={7}
        leaf={58}
        fill="var(--forest-700)"
        stem="var(--forest-500)"
      />
      <Sprig
        x={150}
        y={380}
        h={140}
        lean={-20}
        leaves={5}
        leaf={46}
        fill="var(--forest-500)"
        stem="var(--forest-300)"
      />
      <Sprig
        x={520}
        y={380}
        h={190}
        lean={-30}
        leaves={7}
        leaf={54}
        fill="var(--forest-700)"
        stem="var(--forest-500)"
      />
      <Sprig
        x={440}
        y={380}
        h={110}
        lean={18}
        leaves={4}
        leaf={40}
        fill="var(--forest-500)"
        stem="var(--forest-300)"
      />
      {/* the lens */}
      <g transform="translate(300 214)">
        <circle r="74" fill="rgba(244,236,220,.1)" stroke="var(--paper)" strokeWidth="9" />
        <path
          d="M-46-34a60 60 0 0 1 36-22"
          fill="none"
          stroke="rgba(255,255,255,.55)"
          strokeWidth="6"
          strokeLinecap="round"
        />
        <path d="M52 52 110 112" stroke="var(--paper)" strokeWidth="14" strokeLinecap="round" />
        <path
          d="M-10 36C-30 8-18-26 6-40M-10 36C10 26 26 -2 6 -40"
          fill="none"
          stroke="var(--blush-200)"
          strokeWidth="3"
          strokeLinecap="round"
        />
        <Leaf x={-4} y={40} len={62} rot={-80} fill="var(--blush-200)" vein="var(--forest-900)" />
        <Leaf x={-4} y={22} len={44} rot={-24} fill="var(--blush-400)" vein="var(--forest-900)" flip />
        <Leaf x={-4} y={22} len={44} rot={-156} fill="var(--blush-400)" vein="var(--forest-900)" />
      </g>
      <Bloom x={96} y={150} r={12} />
      <Bloom x={498} y={198} r={10} petal="var(--blush-200)" />
    </svg>
  );
}

type SceneKind = 'inbox' | 'search' | 'sprout' | 'signal' | 'lost';

/** Small spot illustrations for empty and error states. */
export function Scene({ kind, size = 132 }: { kind: SceneKind; size?: number }) {
  return (
    <svg viewBox="0 0 160 130" width={size} height={(size * 130) / 160} aria-hidden="true">
      <ellipse cx="80" cy="116" rx="62" ry="9" fill="var(--paper-deep)" />
      {kind === 'inbox' && (
        <>
          <path
            d="M34 78 50 48h60l16 30v30a6 6 0 0 1-6 6H40a6 6 0 0 1-6-6Z"
            fill="var(--blush-200)"
            stroke="var(--blush-600)"
            strokeWidth={2.4}
            strokeLinejoin="round"
          />
          <path
            d="M34 78h30c2 9 8 13 16 13s14-4 16-13h30"
            fill="none"
            stroke="var(--blush-600)"
            strokeWidth={2.4}
            strokeLinejoin="round"
          />
          <Sprig
            x={80}
            y={64}
            h={52}
            lean={6}
            leaves={3}
            leaf={26}
            fill="var(--forest-500)"
            stem="var(--forest-700)"
          />
        </>
      )}
      {kind === 'search' && (
        <>
          <circle
            cx="70"
            cy="58"
            r="30"
            fill="var(--forest-100)"
            stroke="var(--forest-700)"
            strokeWidth={5}
          />
          <path d="m93 81 26 26" stroke="var(--forest-700)" strokeWidth={9} strokeLinecap="round" />
          <Leaf x={62} y={72} len={34} rot={-70} fill="var(--forest-500)" />
          <Leaf x={62} y={64} len={24} rot={-20} fill="var(--blush-400)" flip />
        </>
      )}
      {kind === 'sprout' && (
        <>
          <path
            d="M52 92h56l-6 22H58Z"
            fill="var(--blush-400)"
            stroke="var(--blush-600)"
            strokeWidth={2.4}
            strokeLinejoin="round"
          />
          <Sprig
            x={80}
            y={92}
            h={56}
            lean={2}
            leaves={2}
            leaf={30}
            fill="var(--forest-500)"
            stem="var(--forest-700)"
          />
        </>
      )}
      {kind === 'signal' && (
        <>
          <path
            d="M40 80a56 56 0 0 1 80 0M54 92a36 36 0 0 1 52 0M68 104a16 16 0 0 1 24 0"
            fill="none"
            stroke="var(--forest-500)"
            strokeWidth={5}
            strokeLinecap="round"
          />
          <circle cx="80" cy="112" r="5" fill="var(--clay)" />
        </>
      )}
      {kind === 'lost' && (
        <>
          <path
            d="M26 104c14-34 34-52 54-52s40 18 54 52Z"
            fill="var(--forest-100)"
            stroke="var(--forest-700)"
            strokeWidth={2.4}
            strokeLinejoin="round"
          />
          <Sprig
            x={80}
            y={104}
            h={60}
            lean={-8}
            leaves={3}
            leaf={28}
            fill="var(--forest-500)"
            stem="var(--forest-700)"
          />
          <Bloom x={112} y={44} r={8} />
        </>
      )}
    </svg>
  );
}
