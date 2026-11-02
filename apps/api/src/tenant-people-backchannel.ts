export function peopleKeycloakRequest(
  publicIssuer: string,
  backchannelUrl?: string,
  request: typeof fetch = fetch,
): typeof fetch {
  if (backchannelUrl === undefined) return request;
  const issuer = new URL(publicIssuer);
  const issuerBase = issuer.href.replace(/\/$/, '');
  const realmPath = issuer.pathname.replace(/\/$/, '');
  if (
    issuer.protocol !== 'https:' ||
    issuer.username ||
    issuer.password ||
    issuer.search ||
    issuer.hash ||
    !/^\/(?:auth\/)?realms\/[A-Za-z0-9._-]+$/.test(realmPath) ||
    backchannelUrl !== `http://keycloak:8080${realmPath}`
  )
    throw new Error('INVALID_PEOPLE_BACKCHANNEL');
  return async (input, options) => {
    if (typeof input !== 'string' && !(input instanceof URL))
      throw new Error('INVALID_PEOPLE_BACKCHANNEL_REQUEST');
    const target = new URL(input);
    const path = target.pathname.slice(realmPath.length);
    if (
      target.origin !== issuer.origin ||
      target.username ||
      target.password ||
      target.hash ||
      !target.pathname.startsWith(`${realmPath}/`) ||
      target.pathname.includes('%') ||
      (path !== '/protocol/openid-connect/token' && !path.startsWith('/dc-tenant-people/'))
    )
      throw new Error('INVALID_PEOPLE_BACKCHANNEL_REQUEST');
    const destination = backchannelUrl + target.href.slice(issuerBase.length);
    return request(destination, { ...options, redirect: 'error' });
  };
}
