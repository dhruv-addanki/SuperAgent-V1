import { describe, expect, it, vi } from "vitest";
import { LongTermMemory } from "../src/modules/memory/longTermMemory";

describe("long term memory", () => {
  it("stores explicit preferred names", async () => {
    const upsert = vi.fn(async () => undefined);
    const service = new LongTermMemory({
      memoryEntry: { upsert, findUnique: vi.fn() },
      user: { update: vi.fn() }
    } as any);

    await service.maybeExtractMemoryFromConversation({ id: "user_1" }, "my name is Dhruv");

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_key: { userId: "user_1", key: "profile_preferred_name" } },
        update: {
          value: { name: "Dhruv", source: "explicit" },
          confidence: 0.95
        }
      })
    );
  });

  it("stores assistant response preferences", async () => {
    const upsert = vi.fn(async () => undefined);
    const service = new LongTermMemory({
      memoryEntry: {
        findUnique: vi.fn(async () => null),
        upsert
      },
      user: { update: vi.fn() }
    } as any);

    await service.maybeExtractMemoryFromConversation(
      { id: "user_1" },
      "use concise direct replies"
    );

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_key: { userId: "user_1", key: "assistant_response_preferences" } },
        update: {
          value: {
            verbosity: "concise",
            tone: "direct"
          },
          confidence: 0.8
        }
      })
    );
  });

  it("stores configurable personality and style preferences", async () => {
    const upsert = vi.fn(async () => undefined);
    const service = new LongTermMemory({
      memoryEntry: {
        findUnique: vi.fn(async () => null),
        upsert
      },
      user: { update: vi.fn() }
    } as any);

    await service.maybeExtractMemoryFromConversation(
      { id: "user_1" },
      "from now on use a warm casual style, sound like a person, no em dashes, and dont use - in text casually"
    );

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_key: { userId: "user_1", key: "assistant_response_preferences" } },
        update: {
          value: expect.objectContaining({
            tone: "casual",
            style: "warm casual",
            humanLike: true,
            avoidEmDashes: true,
            avoidHyphenSeparators: true
          }),
          confidence: 0.8
        }
      })
    );
  });

  it("validates timezones and updates the user timezone", async () => {
    const upsert = vi.fn(async () => undefined);
    const update = vi.fn(async () => undefined);
    const service = new LongTermMemory({
      memoryEntry: { upsert, findUnique: vi.fn() },
      user: { update }
    } as any);

    const result = await service.maybeExtractMemoryFromConversation(
      { id: "user_1" },
      "my timezone is America/Los_Angeles"
    );

    expect(result.timezone).toBe("America/Los_Angeles");
    expect(update).toHaveBeenCalledWith({
      where: { id: "user_1" },
      data: { timezone: "America/Los_Angeles" }
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_key: { userId: "user_1", key: "preferred_timezone" } }
      })
    );
  });

  it("stores explicit calendar exclusion preferences", async () => {
    const upsert = vi.fn(async () => undefined);
    const service = new LongTermMemory({
      memoryEntry: {
        findUnique: vi.fn(async () => null),
        upsert
      },
      user: { update: vi.fn() }
    } as any);

    await service.maybeExtractMemoryFromConversation(
      { id: "user_1" },
      "don't use events from the calendar called 'Kri School' in my daily digest"
    );

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_key: { userId: "user_1", key: "calendar_exclusion_preferences" } },
        update: {
          value: { excludedCalendarNames: ["Kri School"] },
          confidence: 0.9
        }
      })
    );
  });

  it("stores digest exclusion preferences as calendar exclusions", async () => {
    const upsert = vi.fn(async () => undefined);
    const service = new LongTermMemory({
      memoryEntry: {
        findUnique: vi.fn(async () => null),
        upsert
      },
      user: { update: vi.fn() }
    } as any);

    await service.maybeExtractMemoryFromConversation(
      { id: "user_1" },
      "exclude kri school from basic summaries and digest"
    );

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_key: { userId: "user_1", key: "calendar_exclusion_preferences" } },
        update: {
          value: { excludedCalendarNames: ["kri school"] },
          confidence: 0.9
        }
      })
    );
  });

  it("merges calendar exclusion preferences", async () => {
    const upsert = vi.fn(async () => undefined);
    const service = new LongTermMemory({
      memoryEntry: {
        findUnique: vi.fn(async () => ({
          value: { excludedCalendarNames: ["Kri School"] }
        })),
        upsert
      },
      user: { update: vi.fn() }
    } as any);

    await service.maybeExtractMemoryFromConversation(
      { id: "user_1" },
      "exclude Personal calendar from calendar summaries"
    );

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: {
          value: { excludedCalendarNames: ["Kri School", "Personal"] },
          confidence: 0.9
        }
      })
    );
  });

  it("ignores invalid timezones", async () => {
    const upsert = vi.fn(async () => undefined);
    const update = vi.fn(async () => undefined);
    const service = new LongTermMemory({
      memoryEntry: { upsert, findUnique: vi.fn() },
      user: { update }
    } as any);

    const result = await service.maybeExtractMemoryFromConversation(
      { id: "user_1" },
      "my timezone is Mars/Base"
    );

    expect(result.timezone).toBeUndefined();
    expect(update).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("does not overwrite an explicit name with an OAuth candidate", async () => {
    const upsert = vi.fn(async () => undefined);
    const service = new LongTermMemory({
      memoryEntry: {
        findUnique: vi.fn(async () => ({
          value: { name: "Dhruv", source: "explicit" }
        })),
        upsert
      }
    } as any);

    await service.rememberNameCandidate("user_1", "Dhruv Addanki", "google");

    expect(upsert).not.toHaveBeenCalled();
  });
});
