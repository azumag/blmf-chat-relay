import { ADMIN_CSS, ADMIN_HTML, ADMIN_SCRIPT } from "./admin";
import { isAuthorized } from "./auth";

export { YouTubeChatRelay } from "./relay";

const RELAY_OBJECT_NAME = "youtube-chat-relay";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (request.method === "GET" && url.pathname === "/") {
        return Response.redirect(new URL("/admin", url).toString(), 302);
      }

      if (request.method === "GET" && url.pathname === "/admin") {
        return textResponse(ADMIN_HTML, "text/html; charset=utf-8", {
          "Content-Security-Policy":
            "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
        });
      }

      if (request.method === "GET" && url.pathname === "/admin.css") {
        return textResponse(ADMIN_CSS, "text/css; charset=utf-8");
      }

      if (request.method === "GET" && url.pathname === "/admin.js") {
        return textResponse(ADMIN_SCRIPT, "text/javascript; charset=utf-8");
      }

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({
          ok: true,
          service: "blmf-chat-relay",
          timestamp: new Date().toISOString(),
        });
      }

      const relay = env.CHAT_RELAY.getByName(RELAY_OBJECT_NAME);

      if (request.method === "GET" && url.pathname === "/api/status") {
        return jsonResponse(await relay.status());
      }

      if (request.method === "POST" && url.pathname === "/api/start") {
        const unauthorized = await requireAuthorization(request, env);
        if (unauthorized !== null) {
          return unauthorized;
        }

        const body = await readJsonObject(request);
        const requestedChannel =
          typeof body.channel === "string" ? body.channel.trim() : "";
        const channel =
          requestedChannel === ""
            ? env.DEFAULT_YOUTUBE_CHANNEL.trim()
            : requestedChannel;
        if (channel === "") {
          return errorResponse(
            "channel を指定するか、DEFAULT_YOUTUBE_CHANNEL を設定してください。",
            400,
          );
        }

        return jsonResponse(await relay.start(channel));
      }

      if (request.method === "POST" && url.pathname === "/api/e2e/start") {
        const unauthorized = await requireAuthorization(request, env);
        if (unauthorized !== null) {
          return unauthorized;
        }

        const body = await readJsonObject(request);
        const requestedChannel =
          typeof body.channel === "string" ? body.channel.trim() : "";
        const channel =
          requestedChannel === ""
            ? env.DEFAULT_YOUTUBE_CHANNEL.trim()
            : requestedChannel;
        if (channel === "") {
          return errorResponse(
            "channel を指定するか、DEFAULT_YOUTUBE_CHANNEL を設定してください。",
            400,
          );
        }

        const videoId =
          typeof body.videoId === "string" ? body.videoId.trim() : "";
        if (videoId === "") {
          return errorResponse("videoId を指定してください。", 400);
        }

        return jsonResponse(await relay.startE2E(channel, videoId));
      }

      if (request.method === "POST" && url.pathname === "/api/stop") {
        const unauthorized = await requireAuthorization(request, env);
        if (unauthorized !== null) {
          return unauthorized;
        }

        return jsonResponse(await relay.stop("manual"));
      }

      if (
        url.pathname.startsWith("/api/") &&
        request.method !== "GET" &&
        request.method !== "POST"
      ) {
        return new Response(null, {
          status: 405,
          headers: secureHeaders({ Allow: "GET, POST" }),
        });
      }

      return errorResponse("Not Found", 404);
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "worker_request_error",
          timestamp: new Date().toISOString(),
          method: request.method,
          path: url.pathname,
          message: errorMessage(error),
        }),
      );

      const status = isClientError(error) ? 400 : 500;
      return errorResponse(errorMessage(error), status);
    }
  },
} satisfies ExportedHandler<Env>;

async function requireAuthorization(
  request: Request,
  env: Env,
): Promise<Response | null> {
  if (await isAuthorized(request, env.ADMIN_TOKEN)) {
    return null;
  }

  return new Response(JSON.stringify({ error: "認証に失敗しました。" }), {
    status: 401,
    headers: secureHeaders({
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "WWW-Authenticate": 'Bearer realm="blmf-chat-relay"',
    }),
  });
}

async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown>> {
  const contentLength = Number.parseInt(
    request.headers.get("Content-Length") ?? "0",
    10,
  );
  if (Number.isFinite(contentLength) && contentLength > 16_384) {
    throw new ClientInputError("リクエスト本文が大きすぎます。");
  }

  const text = await request.text();
  if (text === "") {
    return {};
  }

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new ClientInputError("JSON の形式が正しくありません。");
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ClientInputError("JSON オブジェクトを送信してください。");
  }

  return value as Record<string, unknown>;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: secureHeaders({
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    }),
  });
}

function errorResponse(message: string, status: number): Response {
  return jsonResponse({ error: message }, status);
}

function textResponse(
  body: string,
  contentType: string,
  additionalHeaders: Record<string, string> = {},
): Response {
  return new Response(body, {
    headers: secureHeaders({
      "Content-Type": contentType,
      "Cache-Control": "no-store",
      ...additionalHeaders,
    }),
  });
}

function secureHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy":
      "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    ...headers,
  };
}

class ClientInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientInputError";
  }
}

function isClientError(error: unknown): boolean {
  return (
    error instanceof ClientInputError ||
    (error instanceof Error &&
      /チャンネル|ハンドル|URL|動画ID|動画|ライブ配信|ライブチャット/.test(
        error.message,
      ))
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
