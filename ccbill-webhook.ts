// Deliberately fail closed until merchant-specific authentication and independent
// CCBill subscription reconciliation are configured and tested. Do NOT trust
// user-supplied forwarded IP headers or invent a CCBill HMAC signature scheme.
// The official webhook guide documents sender IP ranges; enforce them at a
// trusted ingress and independently reconcile events against the merchant API.
// Never log or persist raw webhook bodies (they can contain billing information).
Deno.serve((request: Request) => {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', {status:405,headers:{Allow:'POST'}});
  }
  return new Response(JSON.stringify({error:'processor_setup_required'}), {
    status:503, headers:{'Content-Type':'application/json','Retry-After':'3600','Cache-Control':'no-store'}
  });
});
