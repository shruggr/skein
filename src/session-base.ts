// Where a sender opens its BRC-103 session for a URL (shared by the host's
// deliverer, src/host/deliver.ts, and the client's RawBox, src/client/raw.ts).
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
