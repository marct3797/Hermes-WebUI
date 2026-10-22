export type Route = { profile?: string; sessionId?: string };

export function parseHash(hash: string): Route {
  const [, profile, sessionId] = /^#\/([^/]+)(?:\/([^/]+))?/.exec(hash) ?? [];
  try {
    return { profile: profile && decodeURIComponent(profile), sessionId: sessionId && decodeURIComponent(sessionId) };
  } catch {
    return {};
  }
}

export const toHash = (r: Route) =>
  r.profile ? `#/${encodeURIComponent(r.profile)}${r.sessionId ? `/${encodeURIComponent(r.sessionId)}` : ""}` : "#/";
