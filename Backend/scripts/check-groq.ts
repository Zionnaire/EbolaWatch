/**
 * Tries the counter-narrative writer once against the real Groq API, using GROQ_API_KEY from .env and the fact base.
 * It sends only the sample claim below (no real posts, no personal data) and never prints the key.
 *
 *   pnpm check:groq
 *   pnpm check:groq "Drinking hot water cures Ebola"
 *   pnpm check:groq --models          list the models your key can use
 */
import path from 'node:path';
import { loadConfigLoose } from './lib/looseConfig.js';
import { FactBase } from '../src/knowledge/factBase.js';
import { GroqClient } from '../src/services/narratives/groqClient.js';
import { GroqRagGenerator } from '../src/services/narratives/ragGenerator.js';

async function main() {
  const c = loadConfigLoose();
  if (!c.GROQ_API_KEY) throw new Error('GROQ_API_KEY is not set in Backend/.env');

  if (process.argv.includes('--models')) {
    // lists the models this key can use, so GROQ_MODEL can be set to one that exists
    const res = await fetch(`${c.GROQ_BASE_URL.replace(/\/$/, '')}/models`, {
      headers: { Authorization: `Bearer ${c.GROQ_API_KEY}` },
    });
    if (!res.ok) throw new Error(`Groq answered ${res.status} when listing models`);
    const body = (await res.json()) as {
      data?: Array<{ id: string; owned_by?: string; context_window?: number }>;
    };
    for (const m of (body.data ?? []).sort((x, y) => x.id.localeCompare(y.id)))
      console.log(
        `${m.id}${m.owned_by ? `  (${m.owned_by})` : ''}${m.context_window ? `  ctx ${m.context_window}` : ''}`,
      );
    return;
  }
  const facts = FactBase.fromFile(path.resolve(c.KNOWLEDGE_FILE));
  const claim =
    process.argv.find((a, i) => i >= 2 && !a.startsWith('--')) ?? 'Drinking salt water cures Ebola';
  console.log(`Model: ${c.GROQ_MODEL}`);
  console.log(`Fact base: ${facts.version} (${facts.status}), ${facts.usable().length} usable facts`);
  console.log(`Claim: ${claim}\n`);

  const gen = new GroqRagGenerator(
    new GroqClient({
      apiKey: c.GROQ_API_KEY,
      model: c.GROQ_MODEL,
      baseUrl: c.GROQ_BASE_URL,
      timeoutMs: c.GROQ_TIMEOUT_MS,
    }),
    facts,
  );
  const t0 = Date.now();
  const draft = await gen.generate({
    claim,
    category: 'fake_cure_prevention',
    categoryName: 'Fake cure or prevention',
    language: 'en',
    platform: 'x',
    charLimit: 280,
    guidance: null,
    attempt: 0,
  });
  console.log(`Draft (${draft.text.length} chars, ${Date.now() - t0} ms):\n${draft.text}\n`);
  console.log('Citations:');
  for (const x of draft.citations) console.log(`  - ${x.source}: ${x.title}\n    ${x.url}`);
  console.log('Warnings:');
  for (const w of draft.warnings) console.log(`  - ${w}`);
}

main().catch((err: unknown) => {
  console.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
