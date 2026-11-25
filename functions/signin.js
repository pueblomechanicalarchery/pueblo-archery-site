// Cloudflare Access protects /signin. Reaching this function means the email code
// was accepted, so send the archer back to the members area.
export const onRequest = () => new Response(null, { status: 302, headers: { location: '/#members', 'cache-control': 'no-store' } });
