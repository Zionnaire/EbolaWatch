/**
 * Creates the platform operator (super admin): the one account that can create organizations. There is no other
 * way to create it, on purpose. Run it once per environment.
 *
 *   pnpm admin:create-super                       (asks for email and password)
 *   SUPER_ADMIN_EMAIL=... SUPER_ADMIN_PASSWORD=... pnpm admin:create-super
 *
 * It never prints the password and refuses to create a second account with the same email.
 */
import { createInterface } from 'node:readline';
import mongoose from 'mongoose';
import { loadConfig } from '../src/config.js';
import { EmailSchema, PasswordSchema } from '../src/contracts/api/index.js';
import { UserModel } from '../src/models/User.js';
import { hashPassword } from '../src/utils/password.js';

function ask(question: string, { hidden = false } = {}): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      // mute echo of what is typed
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
        if (s.includes(question)) process.stdout.write(s);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function main() {
  const config = loadConfig();
  const rawEmail = process.env.SUPER_ADMIN_EMAIL ?? (await ask('Super admin email: '));
  const rawPassword =
    process.env.SUPER_ADMIN_PASSWORD ?? (await ask('Password (min 10 characters): ', { hidden: true }));

  const email = EmailSchema.safeParse(rawEmail);
  const password = PasswordSchema.safeParse(rawPassword);
  if (!email.success) throw new Error(`Invalid email: ${email.error.issues[0]?.message}`);
  if (!password.success) throw new Error(`Invalid password: ${password.error.issues[0]?.message}`);

  await mongoose.connect(config.MONGODB_URI, { dbName: config.MONGODB_DB });
  if (await UserModel.exists({ email: email.data }))
    throw new Error(`An account with ${email.data} already exists`);

  const user = await UserModel.create({
    email: email.data,
    name: 'Platform administrator',
    passwordHash: await hashPassword(password.data),
    role: 'super_admin',
    organizationId: null,
    createdBy: 'create-super-admin script',
  });
  console.log(
    `Created super admin ${email.data} (id ${String(user._id)}) in database "${config.MONGODB_DB}".`,
  );
}

main()
  .catch((err: unknown) => {
    console.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
