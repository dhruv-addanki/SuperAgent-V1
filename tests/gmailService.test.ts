import { describe, expect, it } from "vitest";
import { encodeMimeMessage } from "../src/modules/google/gmailService";

describe("gmail MIME encoding", () => {
  it("encodes non-ascii subjects as RFC 2047 MIME headers", () => {
    const raw = encodeMimeMessage(
      "dhruvaddanki@gmail.com",
      "Reminder: Tomorrow’s 9:00 AM meeting",
      "Body"
    );

    const decoded = Buffer.from(raw, "base64url").toString("utf8");

    expect(decoded).toContain(
      "Subject: =?UTF-8?B?UmVtaW5kZXI6IFRvbW9ycm934oCZcyA5OjAwIEFNIG1lZXRpbmc=?="
    );
    expect(decoded).not.toContain("Tomorrowâ");
  });

  it("keeps ascii subjects readable", () => {
    const raw = encodeMimeMessage(
      "dhruvaddanki@gmail.com",
      "Reminder: Tomorrow's 9:00 AM meeting",
      "Body"
    );

    const decoded = Buffer.from(raw, "base64url").toString("utf8");

    expect(decoded).toContain("Subject: Reminder: Tomorrow's 9:00 AM meeting");
  });
});
