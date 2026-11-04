import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { NOT_FLAGGED_COLOR, UNCLASSIFIED_COLOR, colorAt } from '@/config/palette';
import type { TimeseriesDto } from '@/contracts';
import type { Names } from '@/hooks/useNames';
import { formatDay } from '@/utils/format';

/** Seven-day stacked bars: one bar per Lagos day, one segment per category (plus "not flagged"/"unclassified"). */
export function StackedDays({ data, names }: { data: TimeseriesDto; names: Names }) {
  const keyOf = (s: TimeseriesDto['series'][number]) => s.key;
  const labelOf = (s: TimeseriesDto['series'][number]) =>
    s.kind === 'category'
      ? names.category(s.key)
      : s.kind === 'not_flagged'
        ? 'Not flagged'
        : 'Not yet classified';

  const rows = data.days.map((day, i) => ({
    day,
    ...Object.fromEntries(data.series.map((s) => [keyOf(s), s.counts[i] ?? 0])),
  }));
  let colorIndex = 0;
  const colored = data.series.map((s) => ({
    s,
    color:
      s.kind === 'category'
        ? colorAt(colorIndex++)
        : s.kind === 'not_flagged'
          ? NOT_FLAGGED_COLOR
          : UNCLASSIFIED_COLOR,
  }));

  return (
    <div
      role="img"
      aria-label={`Posts per day for the last ${data.days.length} days, split by category. Totals: ${data.totals.join(', ')}.`}
      style={{ height: 280 }}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 6, right: 6, left: -14, bottom: 0 }} barCategoryGap="22%">
          <CartesianGrid vertical={false} stroke="#e6d9c0" strokeDasharray="3 4" />
          <XAxis
            dataKey="day"
            tickFormatter={formatDay}
            tickLine={false}
            axisLine={false}
            tick={{ fill: '#55645f', fontSize: 12 }}
          />
          <YAxis
            allowDecimals={false}
            tickLine={false}
            axisLine={false}
            tick={{ fill: '#55645f', fontSize: 12 }}
          />
          <Tooltip
            cursor={{ fill: 'rgba(191,79,54,.07)' }}
            labelFormatter={(d) => formatDay(String(d))}
            contentStyle={{
              borderRadius: 12,
              border: '1px solid #e6d9c0',
              background: '#fffaf0',
              boxShadow: '0 8px 24px -12px rgba(60,45,20,.4)',
            }}
          />
          <Legend iconType="circle" iconSize={9} wrapperStyle={{ fontSize: 12.5, paddingTop: 8 }} />
          {colored.map(({ s, color }, i) => (
            <Bar
              key={keyOf(s)}
              dataKey={keyOf(s)}
              name={labelOf(s)}
              stackId="d"
              fill={color}
              radius={i === colored.length - 1 ? [5, 5, 0, 0] : 0}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
