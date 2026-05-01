import { describe, expect, it } from "vitest";
import { classifyIntentRoute } from "../src/modules/agent/intentRouter";

describe("intent router", () => {
  it("routes explicit calendar reads to the calendar shortcut", () => {
    const route = classifyIntentRoute({ text: "check my calendar" });

    expect(route).toMatchObject({
      domains: ["calendar"],
      primaryDomain: "calendar",
      action: "read",
      confidence: "high",
      requiredIntegrations: ["google"],
      shortcutCandidate: "calendar_overview",
      fallbackReason: "deterministic_shortcut"
    });
  });

  it("does not gate on weak calendar-adjacent wording", () => {
    const route = classifyIntentRoute({ text: "schedule looks packed" });

    expect(route).toMatchObject({
      domains: ["general"],
      primaryDomain: "general",
      action: "unknown",
      confidence: "low",
      requiredIntegrations: []
    });
    expect(route.shortcutCandidate).toBeUndefined();
  });

  it("routes My Tasks date reads to the Asana list shortcut", () => {
    const route = classifyIntentRoute({
      text: "show my Asana tasks due today",
      timezone: "America/New_York"
    });

    expect(route).toMatchObject({
      domains: ["asana"],
      primaryDomain: "asana",
      action: "read",
      confidence: "high",
      requiredIntegrations: ["asana"],
      shortcutCandidate: "asana_list",
      fallbackReason: "deterministic_shortcut"
    });
  });

  it("routes named Asana project reads with a projectName entity", () => {
    const route = classifyIntentRoute({ text: "show tasks in Scanis" });

    expect(route).toMatchObject({
      domains: ["asana"],
      primaryDomain: "asana",
      action: "read",
      confidence: "high",
      requiredIntegrations: ["asana"],
      shortcutCandidate: "asana_project_tasks"
    });
    expect(route.entities).toContainEqual({
      type: "asana_project_name",
      value: "Scanis"
    });
  });

  it("routes email send requests as Gmail drafts", () => {
    const route = classifyIntentRoute({ text: "send an email to Brad" });

    expect(route).toMatchObject({
      domains: ["gmail"],
      primaryDomain: "gmail",
      action: "draft",
      confidence: "high",
      requiredIntegrations: ["google"]
    });
    expect(route.shortcutCandidate).toBeUndefined();
  });

  it("treats send-it as confirmation only when a pending action exists", () => {
    const withoutPending = classifyIntentRoute({ text: "send it" });
    const withPending = classifyIntentRoute({ text: "send it", hasPendingAction: true });

    expect(withoutPending).toMatchObject({
      domains: ["general"],
      action: "unknown",
      confidence: "low",
      requiredIntegrations: []
    });
    expect(withPending).toMatchObject({
      domains: ["general"],
      action: "send",
      requiredIntegrations: []
    });
  });

  it("routes ticker/news style requests to web without integration gating", () => {
    const route = classifyIntentRoute({ text: "what's NVDA doing today" });

    expect(route).toMatchObject({
      domains: ["web"],
      primaryDomain: "web",
      action: "read",
      confidence: "high",
      requiredIntegrations: []
    });
  });

  it("routes compound calendar plus Asana reads to model fallback", () => {
    const route = classifyIntentRoute({ text: "check calendar and Asana due today" });

    expect(route).toMatchObject({
      domains: ["calendar", "asana"],
      primaryDomain: "multi",
      action: "read",
      confidence: "high",
      isCompound: true,
      requiredIntegrations: ["google", "asana"],
      fallbackReason: "compound_model_loop"
    });
    expect(route.shortcutCandidate).toBeUndefined();
  });

  it("does not add user-commanded WhatsApp contact-send behavior", () => {
    const route = classifyIntentRoute({ text: "send a WhatsApp to Rohan saying hi" });

    expect(route.domains).toEqual(["general"]);
    expect(route.requiredIntegrations).toEqual([]);
    expect(route.shortcutCandidate).toBeUndefined();
  });
});
