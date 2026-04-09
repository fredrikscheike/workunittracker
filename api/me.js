// api/me.js — returns logged-in user info from session cookie
export async function GET(req) {
  const session = getSession(req);
  if (!session) {
    return Response.json({ authenticated: false }, { status: 401 });
  }

  try {
    const res = await fetch(`${session.instanceUrl}/services/oauth2/userinfo`, {
      headers: { Authorization: `Bearer ${session.accessToken}` },
    });
    if (!res.ok) return Response.json({ authenticated: false }, { status: 401 });
    const info = await res.json();
    return Response.json({
      authenticated: true,
      name:  info.name,
      email: info.email,
    });
  } catch {
    return Response.json({ authenticated: false }, { status: 401 });
  }
}

export function getSession(req) {
  try {
    const cookies = parseCookies(req.headers.get('cookie') || '');
    const raw = cookies['sf_session'];
    if (!raw) return null;
    return JSON.parse(atob(raw));
  } catch {
    return null;
  }
}

function parseCookies(str) {
  return Object.fromEntries(
    str.split(';').map(c => c.trim().split('=').map(s => decodeURIComponent(s)))
  );
}
