import { Bar, BarChart, Cell, LabelList, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import { percent } from '@/utils/format';

export interface ScoreRow {
  id: string;
  name: string;
  score: number;
  /** Highlight (the label the model chose, or categories over the decision threshold). */
  active?: boolean;
}

/** Horizontal bars for a set of 0..1 scores (category scores, or 3-class probabilities). Values are printed too. */
export function ScoreBars({ rows, label }: { rows: ScoreRow[]; label: string }) {
  const sorted = [...rows].sort((a, b) => b.score - a.score);
  const height = Math.max(120, sorted.length * 34 + 16);
  return (
    <div
      role="img"
      aria-label={`${label}: ${sorted.map((r) => `${r.name} ${percent(r.score)}`).join(', ')}`}
      style={{ height }}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={sorted}
          layout="vertical"
          margin={{ top: 0, right: 46, left: 0, bottom: 0 }}
          barCategoryGap="28%"
        >
          <XAxis type="number" domain={[0, 1]} hide />
          <YAxis
            type="category"
            dataKey="name"
            width={170}
            tickLine={false}
            axisLine={false}
            tick={{ fill: '#22302d', fontSize: 13 }}
          />
          <Bar
            dataKey="score"
            radius={[0, 7, 7, 0]}
            background={{ fill: '#efe5d1', radius: 7 }}
            isAnimationActive={false}
          >
            {sorted.map((r) => (
              <Cell key={r.id} fill={r.active ? '#bf4f36' : '#6f9a63'} />
            ))}
            <LabelList
              dataKey="score"
              position="right"
              formatter={(v: unknown) => percent(Number(v))}
              style={{ fill: '#22302d', fontSize: 12.5, fontWeight: 600 }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
