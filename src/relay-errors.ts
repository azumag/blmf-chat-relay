import { YouTubeApiError } from "./youtube";

export function isFatalYouTubeError(error: YouTubeApiError): boolean {
  if (
    error.hasReason(
      "quotaExceeded",
      "dailyLimitExceeded",
      "dailyLimitExceededUnreg",
      "keyInvalid",
      "accessNotConfigured",
      "ipRefererBlocked",
      "forbidden",
      "liveChatDisabled",
      "channelNotFound",
      "insufficientPermissions",
      "unauthorized",
    )
  ) {
    return true;
  }

  if (error.hasReason("rateLimitExceeded", "networkError")) {
    return false;
  }

  return (
    error.status === 400 ||
    error.status === 401 ||
    (error.status === 403 && !error.hasReason("rateLimitExceeded"))
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
