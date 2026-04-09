// api/auth/login.js — redirects user to Salesforce OAuth
export async function GET(req) {
  const clientId    = process.env.SF_CLIENT_ID;
  const instanceUrl = process.env.SF_INSTANCE_URL;
  const redirectUri = process.env.SF_REDIRECT_URI;

  if (!clientId || !instanceUrl || !redirectUri) {
    return Response.json({ error: 'Salesforce not configured' }, { status: 503 });
  }

  // PKCE: generate code_verifier and code_challenge
  const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
  const codeVerifier  = base64url(verifierBytes);

  const challengeBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
  const codeChallenge  = base64url(new Uint8Array(challengeBytes));

  const state = base64url(crypto.getRandomValues(new Uint8Array(16)));

  const url = new URL(`${instanceUrl}/services/oauth2/authorize`);
  url.searchParams.set('response_type',          'code');
  url.searchParams.set('client_id',              clientId);
  url.searchParams.set('redirect_uri',           redirectUri);
  url.searchParams.set('code_challenge',         codeChallenge);
  url.searchParams.set('code_challenge_method',  'S256');
  url.searchParams.set('state',                  state);

  const cookieOpts = 'HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600';
  return new Response(null, {
    status: 302,
    headers: {
      'Location':   url.toString(),
      'Set-Cookie': [
        `sf_cv=${codeVerifier}; ${cookieOpts}`,
        `sf_st=${state}; ${cookieOpts}`,
      ].join(', '),
    },
  });
}

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
