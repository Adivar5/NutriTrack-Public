// Shared request authentication for API routes: Supabase JWT + ALLOWED_EMAILS.
// Returns the user object, or null after having sent the 401/403 response itself.
// Fails CLOSED: with no ALLOWED_EMAILS configured, nobody is allowed in.
export async function authenticate(req, res) {
  const token = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    res.status(401).json({ error: 'Missing authorization token' });
    return null;
  }

  let user;
  try {
    const userRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'apikey': process.env.SUPABASE_ANON_KEY,
      },
    });
    if (!userRes.ok) {
      res.status(401).json({ error: 'Invalid or expired session' });
      return null;
    }
    user = await userRes.json();
  } catch (err) {
    console.error('auth validation failed:', err.message);
    res.status(401).json({ error: 'Auth validation failed' });
    return null;
  }

  const allowed = (process.env.ALLOWED_EMAILS || '')
    .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  if (!allowed.length) {
    console.error('ALLOWED_EMAILS is not set: refusing all requests');
    res.status(403).json({ error: 'Access denied' });
    return null;
  }
  if (!allowed.includes((user.email || '').toLowerCase())) {
    res.status(403).json({ error: 'Access denied' });
    return null;
  }
  return user;
}
