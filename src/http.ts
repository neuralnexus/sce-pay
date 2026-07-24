async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const a = new Uint8Array(leftHash);
  const b = new Uint8Array(rightHash);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

export async function authorized(
  request: Request,
  env: { ADMIN_TOKEN?: string },
): Promise<boolean> {
  if (!env.ADMIN_TOKEN) return false;
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return false;
  const presented = header.slice(7);
  if (presented.length === 0 || presented.length > 128) return false;
  return constantTimeEqual(presented, env.ADMIN_TOKEN);
}

export async function readBody(
  request: Request,
  maximum: number,
): Promise<ArrayBuffer> {
  if (maximum === 0) return new ArrayBuffer(0);
  const contentType = request.headers.get("content-type")?.split(";", 1)[0];
  if (contentType !== "application/json") {
    throw new Response("JSON required", { status: 415 });
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maximum) {
    throw new Response("request too large", { status: 413 });
  }
  const body = await request.arrayBuffer();
  if (body.byteLength > maximum) {
    throw new Response("request too large", { status: 413 });
  }
  return body;
}
