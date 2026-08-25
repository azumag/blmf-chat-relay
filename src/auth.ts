const encoder = new TextEncoder();
const COMPARISON_KEY = encoder.encode("blmf-chat-relay-admin-token-v1");

export async function isAuthorized(
  request: Request,
  expectedToken: string,
): Promise<boolean> {
  const candidate = readBearerToken(request.headers.get("Authorization"));
  if (candidate === null || expectedToken === "") {
    return false;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    COMPARISON_KEY,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const expectedSignature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(expectedToken),
  );

  return crypto.subtle.verify(
    "HMAC",
    key,
    expectedSignature,
    encoder.encode(candidate),
  );
}

export function readBearerToken(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  const token = match?.[1]?.trim();
  return token === undefined || token === "" ? null : token;
}
