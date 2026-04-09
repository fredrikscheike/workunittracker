// api/auth/logout.js — clears the session cookie
export function GET() {
  return new Response(null, {
    status: 302,
    headers: {
      'Location':   '/',
      'Set-Cookie': 'sf_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
    },
  });
}
