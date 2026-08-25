import { describe, expect, it } from "vitest";
import { isAuthorized } from "../src/auth";
import {
  classifyLiveChatItem,
  findActiveBroadcast,
  parseChannelReference,
  resolveChannel,
  YouTubeApiError,
  type Fetcher,
} from "../src/youtube";

describe("isAuthorized", () => {
  it("Secretが未設定ならBearer値にかかわらず拒否する", async () => {
    const request = new Request("https://example.com/api/start", {
      headers: { Authorization: "Bearer undefined" },
    });

    await expect(isAuthorized(request, undefined)).resolves.toBe(false);
  });

  it("空のSecretを拒否する", async () => {
    const request = new Request("https://example.com/api/start", {
      headers: { Authorization: "Bearer token" },
    });

    await expect(isAuthorized(request, "   ")).resolves.toBe(false);
  });

  it("一致するBearerトークンだけを許可する", async () => {
    const authorized = new Request("https://example.com/api/start", {
      headers: { Authorization: "Bearer expected-token" },
    });
    const rejected = new Request("https://example.com/api/start", {
      headers: { Authorization: "Bearer other-token" },
    });

    await expect(isAuthorized(authorized, "expected-token")).resolves.toBe(
      true,
    );
    await expect(isAuthorized(rejected, "expected-token")).resolves.toBe(
      false,
    );
  });
});

describe("parseChannelReference", () => {
  it("チャンネルIDを受け付ける", () => {
    expect(parseChannelReference("UC1234567890123456789012")).toEqual({
      kind: "id",
      value: "UC1234567890123456789012",
    });
  });

  it("ハンドルURLを受け付ける", () => {
    expect(
      parseChannelReference("https://www.youtube.com/@blue-moon-festival"),
    ).toEqual({ kind: "handle", value: "blue-moon-festival" });
  });

  it("旧custom URLは誤解決せず拒否する", () => {
    expect(() =>
      parseChannelReference("https://www.youtube.com/c/blue-moon-festival"),
    ).toThrow(/対応している形式/);
  });
});

describe("classifyLiveChatItem", () => {
  it("表示可能なコメントを出力形式へ変換する", () => {
    expect(
      classifyLiveChatItem({
        id: "message-1",
        snippet: {
          type: "textMessageEvent",
          publishedAt: "2026-08-25T01:02:03Z",
          hasDisplayContent: true,
          displayMessage: "こんにちは",
        },
        authorDetails: {
          channelId: "viewer-channel",
          displayName: "視聴者名",
        },
      }),
    ).toEqual({
      kind: "upsert",
      comment: {
        id: "message-1",
        authorChannelId: "viewer-channel",
        name: "視聴者名",
        message: "こんにちは",
        created_at: "2026-08-25T01:02:03.000Z",
      },
    });
  });

  it("tombstoneを削除操作へ変換する", () => {
    expect(
      classifyLiveChatItem({
        id: "deleted-message",
        snippet: { type: "tombstone" },
      }),
    ).toEqual({ kind: "delete-message", messageId: "deleted-message" });
  });

  it("BANされたユーザーのコメント削除を指示する", () => {
    expect(
      classifyLiveChatItem({
        id: "ban-event",
        snippet: {
          type: "userBannedEvent",
          userBannedDetails: {
            bannedUserDetails: { channelId: "banned-viewer" },
          },
        },
      }),
    ).toEqual({ kind: "delete-author", authorChannelId: "banned-viewer" });
  });
});

describe("YouTube API helpers", () => {
  it("ハンドルからチャンネルIDを解決する", async () => {
    const fetcher: Fetcher = async (input) => {
      const url = new URL(input.toString());
      expect(url.pathname).toBe("/youtube/v3/channels");
      expect(url.searchParams.get("forHandle")).toBe("blue-moon");
      return Response.json({
        items: [{ id: "UC1234567890123456789012", snippet: { title: "Blue Moon" } }],
      });
    };

    await expect(resolveChannel("api-key", "@blue-moon", fetcher)).resolves.toEqual({
      id: "UC1234567890123456789012",
      title: "Blue Moon",
    });
  });

  it("現在アクティブな配信とlive chat IDを取得する", async () => {
    let requestCount = 0;
    const fetcher: Fetcher = async (input) => {
      requestCount += 1;
      const url = new URL(input.toString());
      if (url.pathname.endsWith("/search")) {
        expect(url.searchParams.get("channelId")).toBe(
          "UC1234567890123456789012",
        );
        expect(url.searchParams.get("eventType")).toBe("live");
        return Response.json({
          items: [
            { id: { videoId: "older" } },
            { id: { videoId: "newer" } },
          ],
        });
      }

      expect(url.pathname).toMatch(/\/videos$/);
      return Response.json({
        items: [
          {
            id: "older",
            snippet: { title: "古い配信" },
            liveStreamingDetails: {
              actualStartTime: "2026-08-25T01:00:00Z",
              activeLiveChatId: "chat-old",
            },
          },
          {
            id: "newer",
            snippet: { title: "現在の配信" },
            liveStreamingDetails: {
              actualStartTime: "2026-08-25T02:00:00Z",
              activeLiveChatId: "chat-new",
            },
          },
        ],
      });
    };

    await expect(
      findActiveBroadcast(
        "api-key",
        "UC1234567890123456789012",
        fetcher,
      ),
    ).resolves.toEqual({
      videoId: "newer",
      title: "現在の配信",
      liveChatId: "chat-new",
      actualStartTime: "2026-08-25T02:00:00.000Z",
    });
    expect(requestCount).toBe(2);
  });

  it("ライブ中でもチャットが無効なら明示的なエラーにする", async () => {
    const fetcher: Fetcher = async (input) => {
      const url = new URL(input.toString());
      if (url.pathname.endsWith("/search")) {
        return Response.json({
          items: [{ id: { videoId: "live-without-chat" } }],
        });
      }

      return Response.json({
        items: [
          {
            id: "live-without-chat",
            snippet: { title: "チャット無効の配信" },
            liveStreamingDetails: {
              actualStartTime: "2026-08-25T02:00:00Z",
            },
          },
        ],
      });
    };

    await expect(
      findActiveBroadcast(
        "api-key",
        "UC1234567890123456789012",
        fetcher,
      ),
    ).rejects.toMatchObject({
      status: 403,
      reasons: ["liveChatDisabled"],
    });
  });

  it("APIエラー理由を保持する", async () => {
    const fetcher: Fetcher = async () =>
      Response.json(
        {
          error: {
            message: "quota exceeded",
            errors: [{ reason: "quotaExceeded" }],
          },
        },
        { status: 403 },
      );

    try {
      await resolveChannel("api-key", "@blue-moon", fetcher);
      throw new Error("expected resolveChannel to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(YouTubeApiError);
      expect(error).toMatchObject({
        status: 403,
        reasons: ["quotaExceeded"],
      });
    }
  });
});
