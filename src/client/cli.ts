// skein — the client (skein next): the operator's admin commands (admin-cli.ts), each root's
// requests signed here with the operator's key and handed to the running host.
//
//   skein install|uninstall|routes|grant|claim|deploy …   (src/client/admin-cli.ts ADMIN_USAGE)
//
// (The chat client — whoami, import, run, head, inbox, chat, talk — spoke to an instance's stock
// mailbox through the mail program: gone with it, not in the first cut.)

export async function main(argv: string[]): Promise<number> {
  const { ADMIN_COMMANDS, ADMIN_USAGE, adminMain } = await import("./admin-cli.ts");
  const { withHostEnv } = await import("../host/hostenv.ts");
  const env = { vars: withHostEnv(process.env), out: (l: string) => process.stdout.write(`${l}\n`), err: (l: string) => process.stderr.write(`${l}\n`) };
  if (!(ADMIN_COMMANDS as readonly string[]).includes(argv[0] ?? "")) { env.err(ADMIN_USAGE); return argv[0] === "help" || argv[0] === "--help" ? 0 : 2; }
  if (argv.includes("--help") || argv.includes("-h")) { env.out(ADMIN_USAGE); return 0; }
  return adminMain(argv[0]!, argv.slice(1), env);
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2)).then((code) => process.exit(code), (e: Error) => { process.stderr.write(`skein: ${e.message}\n`); process.exit(1); });
