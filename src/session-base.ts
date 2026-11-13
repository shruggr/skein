// Where a sender opens its BRC-103 session for a URL (a client of an instance on this host's dev form).
//
// A session is with ONE skein, and a URL names the skein it is for as the
// router reads it (src/host/router.ts `target`): its host name, or a leading
// `/@<handle>` path segment. Everything after that is a route inside the
// skein — a messagebox URL such as `https://host/messagebox` or
// `https://host/@alpha/messagebox` is a route, not another server — so the
// session's base is the URL's origin, plus `/@<handle>` when the path starts
// with one, and nothing else of the path. The handshake goes to
// `<base>/.well-known/auth`; requests keep their own paths.

/** The base a sender shakes hands at for `url`: its origin, plus a leading `/@<handle>` segment (no trailing slash). */
export function sessionBase(url: string | URL): string {
  const u = typeof url === "string" ? new URL(url) : url;
  const m = /^\/@([^/]+)(\/.*)?$/.exec(u.pathname);
  return m ? `${u.origin}/@${m[1]}` : u.origin;
}

/**
 * A fetch for the stock AuthFetch at a URL with a `/@<handle>` prefix (the host's dev form): the stock
 * client shakes hands at `<origin>/.well-known/auth`; this sends that handshake under the prefix
 * (`<origin>/@<handle>/.well-known/auth`), so the session is that instance's. Requests keep their paths.
 */
export function prefixedFetch(url: string | URL, base: typeof fetch = (input, init) => globalThis.fetch(input, init)): typeof fetch {
  const u = typeof url === "string" ? new URL(url) : url;
  const prefix = new URL(sessionBase(u)).pathname.replace(/\/$/, "");
  if (!prefix) return base;
  return ((input: string | URL | Request, init?: RequestInit) => {
    const s = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const w = new URL(s);
    if (w.origin === u.origin && w.pathname === "/.well-known/auth") w.pathname = `${prefix}/.well-known/auth`;
    return base(input instanceof Request ? new Request(w, input) : w.href, init);
  }) as typeof fetch;
}
