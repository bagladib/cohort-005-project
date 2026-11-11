import { describe, it, expect } from "vitest";
import { judgeRefundEligibility, type RefundFacts } from "./refund-eligibility";

// A US purchase (no purchasing-power discount) at list price, nothing watched.
function facts(overrides: Partial<RefundFacts> = {}): RefundFacts {
  return {
    purchasedAt: new Date(2026, 0, 1, 23, 0).toISOString(),
    country: "US",
    amountPaid: 10000,
    listPrice: 10000,
    watchedSeconds: 0,
    completedLessons: 0,
    totalLessons: 10,
    claimedTeamSeat: false,
    ...overrides,
  };
}

describe("judgeRefundEligibility", () => {
  describe("Refund Window", () => {
    it("is open on the whole of the fourteenth day after purchase", () => {
      const result = judgeRefundEligibility(facts(), new Date(2026, 0, 15, 23, 59));

      expect(result.rules.refundWindow.passed).toBe(true);
      expect(result.lastDayInWindow).toBe("2026-01-15");
      expect(result.eligible).toBe(true);
    });

    it("is closed from the fifteenth day", () => {
      const result = judgeRefundEligibility(facts(), new Date(2026, 0, 16, 0, 1));

      expect(result.rules.refundWindow.passed).toBe(false);
      expect(result.eligible).toBe(false);
    });

    it("is not open on a day before the purchase", () => {
      const result = judgeRefundEligibility(facts(), new Date(2025, 11, 31, 12));

      expect(result.rules.refundWindow.passed).toBe(false);
    });

    it("is judged on the given date, not today", () => {
      // A Refund Request made inside the window is still inside it when an
      // Instructor looks at it months later.
      const requestedOn = new Date(2026, 0, 10);

      expect(
        judgeRefundEligibility(facts(), requestedOn).rules.refundWindow.passed
      ).toBe(true);
    });
  });

  const insideWindow = new Date(2026, 0, 5);

  describe("watch time", () => {
    it("passes just under 2 hours watched", () => {
      const result = judgeRefundEligibility(
        facts({ watchedSeconds: 7199 }),
        insideWindow
      );

      expect(result.rules.watchTime.passed).toBe(true);
      expect(result.eligible).toBe(true);
    });

    it("fails at 2 hours watched", () => {
      const result = judgeRefundEligibility(
        facts({ watchedSeconds: 7200 }),
        insideWindow
      );

      expect(result.rules.watchTime.passed).toBe(false);
      expect(result.eligible).toBe(false);
    });
  });

  describe("lesson completion", () => {
    it("passes with under half the lessons completed", () => {
      const result = judgeRefundEligibility(
        facts({ completedLessons: 4, totalLessons: 10 }),
        insideWindow
      );

      expect(result.rules.completion.passed).toBe(true);
    });

    it("fails at half the lessons completed, even with little watched", () => {
      const result = judgeRefundEligibility(
        facts({ completedLessons: 5, totalLessons: 10, watchedSeconds: 1200 }),
        insideWindow
      );

      expect(result.rules.completion.passed).toBe(false);
      expect(result.eligible).toBe(false);
    });

    it("passes for a course with no lessons", () => {
      const result = judgeRefundEligibility(
        facts({ completedLessons: 0, totalLessons: 0 }),
        insideWindow
      );

      expect(result.rules.completion.passed).toBe(true);
    });
  });

  describe("team seat", () => {
    it("fails for a claimed team seat", () => {
      const result = judgeRefundEligibility(
        facts({ claimedTeamSeat: true }),
        insideWindow
      );

      expect(result.rules.teamSeat.passed).toBe(false);
      expect(result.eligible).toBe(false);
    });

    it("passes when no team seat has been claimed", () => {
      const result = judgeRefundEligibility(facts(), insideWindow);

      expect(result.rules.teamSeat.passed).toBe(true);
    });
  });

  describe("Refundable Amount", () => {
    it("is the list price when no purchasing-power discount applied", () => {
      const result = judgeRefundEligibility(
        facts({ country: "US", amountPaid: 8000, listPrice: 10000 }),
        insideWindow
      );

      expect(result.refundableAmount).toBe(10000);
    });

    it("is the price paid when a purchasing-power discount applied", () => {
      const result = judgeRefundEligibility(
        facts({ country: "IN", amountPaid: 3000, listPrice: 10000 }),
        insideWindow
      );

      expect(result.refundableAmount).toBe(3000);
    });

    it("is reported even when the purchase is not eligible", () => {
      const result = judgeRefundEligibility(
        facts({ claimedTeamSeat: true }),
        insideWindow
      );

      expect(result.refundableAmount).toBe(10000);
    });
  });
});
