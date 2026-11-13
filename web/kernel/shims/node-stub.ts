// node:fs / node:path for the browser bundle. src/client/conversation.ts imports
// them for its ~/.skein file state, which the page keeps in localStorage
// instead; the pure functions it shares with the page never reach these.
function unavailable(name: string): never {
  throw new Error(`${name} is not available in the browser`);
}
export const readFileSync = () => unavailable("fs.readFileSync");
export const writeFileSync = () => unavailable("fs.writeFileSync");
export const mkdirSync = () => unavailable("fs.mkdirSync");
export const appendFileSync = () => unavailable("fs.appendFileSync");
export const join = (...parts: string[]) => parts.join("/");
export default { readFileSync, writeFileSync, mkdirSync, appendFileSync, join };
