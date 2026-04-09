// api/auth/callback.js — exchanges OAuth code for tokens, sets session cookie
export async function GET(req) {
  const { searchParams } = new URL(req.url, 'http://localhost');
  const code  = searchParams.get('code');
  const state = searchParams.get('state');

  if (!code) {
    return Response.json({ error: 'Missing code' }, { status: 400 });
  }

  // Parse cookies
  const cookies = parseCookies(req.headers.get('cookie') || '');
  const storedState    = cookies['sf_st'];
  const codeVerifier   = cookies['sf_cv'];

  if (!storedState || storedState !== state) {
    return Response.json({ error: 'State mismatch' }, { status: 400 });
  }

  const clientId     = process.env.SF_CLIENT_ID;
  const clientSecret = process.env.SF_CLIENT_SECRET;
  const instanceUrl  = process.env.SF_INSTANCE_URL;
  const redirectUri  = process.env.SF_REDIRECT_URI;

  // Exchange code for tokens
  const tokenRes = await fetch(`${instanceUrl}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'authorization_code',
      client_id:     clientId,
      client_secret: clientSecret,
      redirect_uri:  redirectUri,
      code,
      code_verifier: codeVerifier,
    }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    console.error('SF token exchange failed:', err);
    return Response.json({ error: 'Token exchange failed' }, { status: 502 });
  }

  const tokens = await tokenRes.json();
  // tokens.instance_url may differ from SF_INSTANCE_URL (sandboxes etc.)
  const sfInstanceUrl  = tokens.instance_url || instanceUrl;
  const accessToken    = tokens.access_token;

  // Store token in a single HttpOnly cookie (JSON, base64-encoded)
  const session = btoa(JSON.stringify({ accessToken, instanceUrl: sfInstanceUrl }));
  const cookieOpts = 'HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=86400';

  return new Response(null, {
    status: 302,
    headers: {
      'Location':   '/',
      'Set-Cookie': [
        `sf_session=${session}; ${cookieOpts}`,
        `sf_cv=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
        `sf_st=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
      ].join(', '),
    },
  });
}

function parseCookies(str) {
  return Object.fromEntries(
    str.split(';').map(c => c.trim().split('=').map(decodeURIComponent))
  );
}
