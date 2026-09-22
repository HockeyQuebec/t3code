import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { RESET_BUFFER_SECONDS } from "./agentLimits.ts";
import {
  AUTO_RETRY_ORIGIN,
  buildResumePrompt,
  classifyTurnFailure,
  extractOriginalTask,
  isUsageLimitFailure,
  mayQueueResume,
  resolveResumeAt,
  resolveTransientRetryAt,
  TRANSIENT_RETRY_BASE_SECONDS,
  TRANSIENT_RETRY_MAX_SECONDS,
  USAGE_LIMIT_ORIGIN,
} from "./usageLimitResume.ts";

const NOW = 1_760_000_000;
const NOW_MILLIS = NOW * 1000;

describe("isUsageLimitFailure", () => {
  it("recognises how each provider announces a limit", () => {
    const messages = [
      "Claude usage limit reached. Your limit will reset at 4:00am (America/Indianapolis)",
      "You've reached your weekly usage limit",
      "rate limit exceeded",
      "Error: 429 Too Many Requests",
      "quota exceeded for this billing period",
      "RESOURCE_EXHAUSTED: token quota depleted",
    ];
    for (const message of messages) {
      expect(isUsageLimitFailure(message), message).toBe(true);
    }
  });

  it("does not treat auth and billing failures as waitable", () => {
    const messages = [
      "401 Unauthorized: invalid API key",
      "Authentication failed",
      "Payment required: no active subscription",
      // The words are there, but this one will fail the same way at 4am.
      "Unauthorized — your rate limit tier requires a paid plan",
    ];
    for (const message of messages) {
      expect(isUsageLimitFailure(message), message).toBe(false);
    }
  });

  it("stays quiet for prose that merely mentions limits", () => {
    expect(isUsageLimitFailure("I added rate limiting to the upload handler")).toBe(false);
    expect(isUsageLimitFailure("the context limit is 200k tokens")).toBe(false);
    expect(isUsageLimitFailure("")).toBe(false);
    expect(isUsageLimitFailure(null)).toBe(false);
    expect(isUsageLimitFailure(undefined)).toBe(false);
  });
});

describe("classifyTurnFailure", () => {
  it("still calls a usage limit a usage limit", () => {
    for (const message of [
      "Claude usage limit reached. Your limit will reset at 4:00am",
      "Error: 429 Too Many Requests",
      "RESOURCE_EXHAUSTED: token quota depleted",
    ]) {
      expect(classifyTurnFailure(message), message).toBe("usage-limit");
    }
  });

  it("treats a dead process as worth retrying", () => {
    for (const message of [
      "agent-harness exited with code 137",
      "The process was killed",
      "JavaScript heap out of memory",
      "worker terminated (SIGKILL)",
      "non-zero exit from the workflow runner",
    ]) {
      expect(classifyTurnFailure(message), message).toBe("transient");
    }
  });

  it("treats a dropped connection as worth retrying", () => {
    for (const message of [
      "read ECONNRESET",
      "socket hang up",
      "TypeError: fetch failed",
      "connection reset by peer",
      "stream disconnected before the turn finished",
      "premature close",
    ]) {
      expect(classifyTurnFailure(message), message).toBe("transient");
    }
  });

  it("treats a provider having a bad minute as worth retrying", () => {
    for (const message of [
      "503 Service Unavailable",
      "Error 529: overloaded_error",
      "upstream returned 502 Bad Gateway",
      "The service is temporarily unavailable, try again later",
    ]) {
      expect(classifyTurnFailure(message), message).toBe("transient");
    }
  });

  it("never retries a failure that will fail the same way again", () => {
    for (const message of [
      "401 Unauthorized: invalid API key",
      "403 Forbidden",
      "Authentication failed",
      "Your session token has expired",
      "400 Bad Request: invalid_request_error",
      "Model not found",
      "Payment required: your credit balance is too low",
      "billing account is suspended",
    ]) {
      expect(classifyTurnFailure(message), message).toBe("permanent");
    }
  });

  it("never retries something the user stopped on purpose", () => {
    for (const message of [
      "Interrupted by user.",
      "aborted by user",
      "The turn was cancelled",
      "user stopped the run",
    ]) {
      expect(classifyTurnFailure(message), message).toBe("permanent");
    }
  });

  it("reads a permanent signal even when a retryable one is also present", () => {
    // The 500 is what the transport said; the rejected key is what actually
    // happened, and re-sending it all night would change nothing.
    expect(classifyTurnFailure("500 Internal Server Error: invalid api key")).toBe("permanent");
  });

  it("says permanent for anything it does not recognise", () => {
    expect(classifyTurnFailure("TypeError: cannot read property 'x' of undefined")).toBe(
      "permanent",
    );
    expect(classifyTurnFailure("the build failed")).toBe("permanent");
    expect(classifyTurnFailure("")).toBe("permanent");
    expect(classifyTurnFailure(null)).toBe("permanent");
    expect(classifyTurnFailure(undefined)).toBe("permanent");
  });
});

describe("resolveTransientRetryAt", () => {
  it("waits a minute the first time", () => {
    expect(resolveTransientRetryAt({ attempt: 1, nowSeconds: NOW })).toEqual({
      atSeconds: NOW + TRANSIENT_RETRY_BASE_SECONDS,
    });
  });

  it("doubles the gap as a thread keeps falling over", () => {
    const delays = [1, 2, 3, 4].map(
      (attempt) => resolveTransientRetryAt({ attempt, nowSeconds: NOW }).atSeconds - NOW,
    );
    expect(delays).toEqual([60, 120, 240, 480]);
  });

  it("stops growing at the ceiling", () => {
    expect(resolveTransientRetryAt({ attempt: 12, nowSeconds: NOW }).atSeconds).toBe(
      NOW + TRANSIENT_RETRY_MAX_SECONDS,
    );
    expect(resolveTransientRetryAt({ attempt: 500, nowSeconds: NOW }).atSeconds).toBe(
      NOW + TRANSIENT_RETRY_MAX_SECONDS,
    );
  });

  it("never returns an instant retry, whatever it is handed", () => {
    expect(resolveTransientRetryAt({ attempt: 0, nowSeconds: NOW }).atSeconds).toBe(
      NOW + TRANSIENT_RETRY_BASE_SECONDS,
    );
    expect(resolveTransientRetryAt({ attempt: -3, nowSeconds: NOW }).atSeconds).toBe(
      NOW + TRANSIENT_RETRY_BASE_SECONDS,
    );
  });
});

describe("resolveResumeAt", () => {
  it("believes the failure text over the tracker, and pads past the reset", () => {
    const resolved = resolveResumeAt({
      failureText: `usage limit reached, resets_at ${NOW + 1800}`,
      limitResetsAtSeconds: NOW + 9000,
      nowSeconds: NOW,
      minimumDelaySeconds: 60,
      fallbackDelaySeconds: 1800,
    });

    expect(resolved.source).toBe("errorText");
    expect(resolved.atSeconds).toBe(NOW + 1800 + RESET_BUFFER_SECONDS);
  });

  it("falls back to the tracker when the text names no time", () => {
    const resolved = resolveResumeAt({
      failureText: "usage limit reached",
      limitResetsAtSeconds: NOW + 3600,
      nowSeconds: NOW,
      minimumDelaySeconds: 60,
      fallbackDelaySeconds: 1800,
    });

    expect(resolved.source).toBe("providerLimits");
    expect(resolved.atSeconds).toBe(NOW + 3600 + RESET_BUFFER_SECONDS);
  });

  it("uses the fallback delay when nobody knows when the window reopens", () => {
    const resolved = resolveResumeAt({
      failureText: "usage limit reached",
      limitResetsAtSeconds: null,
      nowSeconds: NOW,
      minimumDelaySeconds: 60,
      fallbackDelaySeconds: 1800,
    });

    expect(resolved).toEqual({ atSeconds: NOW + 1800, source: "fallback" });
  });

  it("ignores a tracked reset that has already passed", () => {
    const resolved = resolveResumeAt({
      failureText: "usage limit reached",
      limitResetsAtSeconds: NOW - 10,
      nowSeconds: NOW,
      minimumDelaySeconds: 60,
      fallbackDelaySeconds: 1800,
    });

    expect(resolved.source).toBe("fallback");
  });

  it("never schedules sooner than the floor, however soon the provider claims", () => {
    const resolved = resolveResumeAt({
      failureText: `usage limit reached, resets_at ${NOW + 5}`,
      limitResetsAtSeconds: null,
      nowSeconds: NOW,
      minimumDelaySeconds: 300,
      fallbackDelaySeconds: 1800,
    });

    expect(resolved.atSeconds).toBe(NOW + 300);
  });
});

describe("buildResumePrompt", () => {
  it("tells a conversational agent to continue rather than restart", () => {
    const prompt = buildResumePrompt({
      kind: "conversation",
      originalTask: "Add a retry to the uploader",
      workspace: null,
      failedStep: null,
    });

    expect(prompt).toContain("Continue");
    expect(prompt).toContain("do not start over");
    // The session still holds the conversation; restating the task invites a
    // fresh start, which is the one thing this is trying to avoid.
    expect(prompt).not.toContain("Add a retry to the uploader");
  });

  it("re-sends the task verbatim for a harness run, with where it got to", () => {
    const prompt = buildResumePrompt({
      kind: "batch",
      originalTask: "Add a retry to the uploader",
      workspace: "/tmp/harness/wt-42",
      failedStep: "implement_section_b",
    });

    expect(prompt).toContain("Add a retry to the uploader");
    expect(prompt).toContain("implement_section_b");
    expect(prompt).toContain("/tmp/harness/wt-42");
  });

  it("does not nest its own preamble when a resume is itself interrupted", () => {
    const first = buildResumePrompt({
      kind: "batch",
      originalTask: "Add a retry to the uploader",
      workspace: "/tmp/harness/wt-42",
      failedStep: "implement",
    });
    const second = buildResumePrompt({
      kind: "batch",
      originalTask: extractOriginalTask(first ?? ""),
      workspace: "/tmp/harness/wt-43",
      failedStep: "review",
    });

    expect(extractOriginalTask(second ?? "")).toBe("Add a retry to the uploader");
    expect(second?.split("A previous run").length).toBe(2);
  });

  it("returns an unmarked prompt unchanged", () => {
    expect(extractOriginalTask("  Add a retry to the uploader  ")).toBe(
      "Add a retry to the uploader",
    );
  });

  it("refuses a harness resume with no task to re-run", () => {
    expect(
      buildResumePrompt({
        kind: "batch",
        originalTask: "   ",
        workspace: "/tmp/harness/wt-42",
        failedStep: null,
      }),
    ).toBeNull();
  });
});

describe("mayQueueResume", () => {
  const row = (
    overrides: Partial<Parameters<typeof mayQueueResume>[0]["queued"][number]> = {},
  ) => ({
    threadId: "thread-1",
    origin: USAGE_LIMIT_ORIGIN,
    status: "dispatched",
    createdAt: DateTime.formatIso(DateTime.makeUnsafe(NOW_MILLIS - 60_000)),
    ...overrides,
  });

  it("allows the first resume for a thread", () => {
    expect(
      mayQueueResume({ threadId: "thread-1", queued: [], nowMillis: NOW_MILLIS, maxPerDay: 6 }),
    ).toBe(true);
  });

  it("refuses while a resume for the same thread is still pending", () => {
    expect(
      mayQueueResume({
        threadId: "thread-1",
        queued: [row({ status: "pending" })],
        nowMillis: NOW_MILLIS,
        maxPerDay: 6,
      }),
    ).toBe(false);
  });

  it("counts only this thread's own automatic resumes", () => {
    expect(
      mayQueueResume({
        threadId: "thread-1",
        queued: [
          row({ threadId: "thread-2", status: "pending" }),
          row({ origin: "user", status: "pending" }),
        ],
        nowMillis: NOW_MILLIS,
        maxPerDay: 6,
      }),
    ).toBe(true);
  });

  it("stops once the daily cap is spent, and lets it back in a day later", () => {
    const spent = Array.from({ length: 3 }, () => row());
    expect(
      mayQueueResume({
        threadId: "thread-1",
        queued: spent,
        nowMillis: NOW_MILLIS,
        maxPerDay: 3,
      }),
    ).toBe(false);

    const yesterday = spent.map(() =>
      row({ createdAt: DateTime.formatIso(DateTime.makeUnsafe(NOW_MILLIS - 25 * 60 * 60 * 1000)) }),
    );
    expect(
      mayQueueResume({
        threadId: "thread-1",
        queued: yesterday,
        nowMillis: NOW_MILLIS,
        maxPerDay: 3,
      }),
    ).toBe(true);
  });
});
