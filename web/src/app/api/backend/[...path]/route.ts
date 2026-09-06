import { NextRequest, NextResponse } from 'next/server';

const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:3001';

// Plain fetch-based proxy — Next's built-in rewrites() proxy enforces a hard
// ~30s socket timeout that isn't configurable and cuts off slower LLM calls
// (e.g. multi-step reasoning modes) before the backend can respond.
async function proxy(request: NextRequest, { params }: { params: { path: string[] } }) {
  const targetUrl = `${BACKEND_URL}/${params.path.join('/')}${request.nextUrl.search}`;

  const response = await fetch(targetUrl, {
    method: request.method,
    headers: { 'Content-Type': request.headers.get('content-type') ?? 'application/json' },
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.text(),
  });

  const body = await response.text();
  return new NextResponse(body, {
    status: response.status,
    headers: { 'Content-Type': response.headers.get('content-type') ?? 'application/json' },
  });
}

export {
  proxy as GET,
  proxy as POST,
  proxy as PUT,
  proxy as PATCH,
  proxy as DELETE,
};
