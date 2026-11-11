import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";

let testDb: ReturnType<typeof createTestDb>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

import { decideRefundRequest } from "./refund-decision";

const VALID_REASON = "The course covers what you asked for in lesson one.";

let base: ReturnType<typeof seedBaseData>;
let refundId: number;
let purchaseId: number;

function addUser(email: string, role: schema.UserRole) {
  return testDb
    .insert(schema.users)
    .values({ name: email, email, role })
    .returning()
    .get();
}

function getRefund() {
  return testDb
    .select()
    .from(schema.refunds)
    .where(eq(schema.refunds.id, refundId))
    .get()!;
}

/** The HTTP status of the response `decide` throws, or a failure if it does not throw. */
function thrownStatus(decide: () => unknown) {
  try {
    decide();
  } catch (error) {
    // What `data(...)` from react-router builds.
    if (
      typeof error === "object" &&
      error !== null &&
      "type" in error &&
      error.type === "DataWithResponseInit" &&
      "init" in error
    ) {
      const init = error.init as ResponseInit | null;
      return init?.status;
    }
    throw error;
  }
  throw new Error("Expected the decision to be refused with a thrown response.");
}

function isEnrolled() {
  return (
    testDb
      .select()
      .from(schema.enrollments)
      .where(eq(schema.enrollments.userId, base.user.id))
      .get() !== undefined
  );
}

beforeEach(() => {
  testDb = createTestDb();
  base = seedBaseData(testDb);

  testDb
    .update(schema.courses)
    .set({ price: 10000 })
    .where(eq(schema.courses.id, base.course.id))
    .run();

  const purchase = testDb
    .insert(schema.purchases)
    .values({
      userId: base.user.id,
      courseId: base.course.id,
      amountPaid: 10000,
      country: "US",
    })
    .returning()
    .get();
  purchaseId = purchase.id;

  testDb
    .insert(schema.enrollments)
    .values({ userId: base.user.id, courseId: base.course.id })
    .run();

  refundId = testDb
    .insert(schema.refunds)
    .values({
      purchaseId,
      reason: "This course was not what I expected.",
    })
    .returning()
    .get().id;
});

describe("decideRefundRequest", () => {
  describe("who may decide", () => {
    it("refuses an Instructor who does not own the Course", () => {
      const other = addUser("other@example.com", schema.UserRole.Instructor);

      const status = thrownStatus(() =>
        decideRefundRequest(refundId, other.id, { intent: "approve" })
      );

      expect(status).toBe(403);
      expect(getRefund().status).toBe(schema.RefundStatus.Requested);
      expect(isEnrolled()).toBe(true);
    });

    it("refuses the learner", () => {
      const status = thrownStatus(() =>
        decideRefundRequest(refundId, base.user.id, { intent: "approve" })
      );

      expect(status).toBe(403);
      expect(getRefund().status).toBe(schema.RefundStatus.Requested);
    });

    it("lets any Admin decide", () => {
      const admin = addUser("admin@example.com", schema.UserRole.Admin);

      const result = decideRefundRequest(refundId, admin.id, {
        intent: "approve",
      });

      expect(result.ok).toBe(true);
      expect(getRefund().resolvedByUserId).toBe(admin.id);
    });

    it("reports a Refund Request that does not exist as 404", () => {
      const status = thrownStatus(() =>
        decideRefundRequest(9999, base.instructor.id, { intent: "approve" })
      );

      expect(status).toBe(404);
    });
  });

  describe("Approve", () => {
    it("lets the owning Instructor approve, recording the Refundable Amount", () => {
      const result = decideRefundRequest(refundId, base.instructor.id, {
        intent: "approve",
      });

      expect(result.ok).toBe(true);
      const refund = getRefund();
      expect(refund.status).toBe(schema.RefundStatus.Approved);
      expect(refund.amountRefunded).toBe(10000);
      expect(refund.resolvedByUserId).toBe(base.instructor.id);
      expect(refund.resolvedAt).not.toBeNull();
    });

    it("removes the learner's access to the Course", () => {
      expect(isEnrolled()).toBe(true);

      decideRefundRequest(refundId, base.instructor.id, { intent: "approve" });

      expect(isEnrolled()).toBe(false);
    });

    it("approves a request that is no longer eligible, because eligibility is advisory", () => {
      // Purchased and requested 30 days ago: outside the Refund Window.
      const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      testDb
        .update(schema.purchases)
        .set({ createdAt: longAgo.toISOString() })
        .where(eq(schema.purchases.id, purchaseId))
        .run();
      testDb
        .update(schema.refunds)
        .set({ requestedAt: longAgo.toISOString() })
        .where(eq(schema.refunds.id, refundId))
        .run();

      const result = decideRefundRequest(refundId, base.instructor.id, {
        intent: "approve",
      });

      expect(result.ok).toBe(true);
      expect(getRefund().status).toBe(schema.RefundStatus.Approved);
      expect(getRefund().amountRefunded).toBe(10000);
    });
  });

  describe("Decline", () => {
    it("stores the trimmed reason and keeps the learner's access", () => {
      const result = decideRefundRequest(refundId, base.instructor.id, {
        intent: "decline",
        reason: `   ${VALID_REASON}  `,
      });

      expect(result.ok).toBe(true);
      const refund = getRefund();
      expect(refund.status).toBe(schema.RefundStatus.Declined);
      expect(refund.declineReason).toBe(VALID_REASON);
      expect(refund.amountRefunded).toBeNull();
      expect(refund.resolvedByUserId).toBe(base.instructor.id);
      expect(refund.resolvedAt).not.toBeNull();
      expect(isEnrolled()).toBe(true);
    });

    it.each([
      ["missing", undefined],
      ["under 10 characters once trimmed", "   too short   "],
      ["over 1000 characters", "x".repeat(1001)],
    ])("refuses a reason that is %s with field errors", (_label, reason) => {
      const result = decideRefundRequest(refundId, base.instructor.id, {
        intent: "decline",
        reason,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.reason).toBeTruthy();
      expect(getRefund().status).toBe(schema.RefundStatus.Requested);
    });

    it("accepts a reason of exactly 1000 characters", () => {
      const result = decideRefundRequest(refundId, base.instructor.id, {
        intent: "decline",
        reason: "x".repeat(1000),
      });

      expect(result.ok).toBe(true);
    });
  });

  it("refuses an unknown intent with field errors", () => {
    const result = decideRefundRequest(refundId, base.instructor.id, {
      intent: "refund-half",
    });

    expect(result.ok).toBe(false);
    expect(getRefund().status).toBe(schema.RefundStatus.Requested);
  });

  describe("email to the learner", () => {
    it("tells the learner their Refund Request was Approved and for how much", () => {
      const result = decideRefundRequest(refundId, base.instructor.id, {
        intent: "approve",
      });

      if (!result.ok) throw new Error("Expected the decision to succeed.");
      expect(result.email.to).toBe("test@example.com");
      expect(result.email.subject).toBe(
        "Refund Request approved — Test Course"
      );
      expect(result.email.body).toContain("approved");
      expect(result.email.body).toContain("$100");
    });

    it("tells the learner their Refund Request was Declined, with the reason", () => {
      const result = decideRefundRequest(refundId, base.instructor.id, {
        intent: "decline",
        reason: VALID_REASON,
      });

      if (!result.ok) throw new Error("Expected the decision to succeed.");
      expect(result.email.to).toBe("test@example.com");
      expect(result.email.subject).toBe(
        "Refund Request declined — Test Course"
      );
      expect(result.email.body).toContain("declined");
      expect(result.email.body).toContain(VALID_REASON);
    });
  });

  describe("decisions are final", () => {
    it("refuses a second decision on an Approved request with 409", () => {
      decideRefundRequest(refundId, base.instructor.id, { intent: "approve" });

      const status = thrownStatus(() =>
        decideRefundRequest(refundId, base.instructor.id, {
          intent: "decline",
          reason: VALID_REASON,
        })
      );

      expect(status).toBe(409);
      expect(getRefund().status).toBe(schema.RefundStatus.Approved);
      expect(getRefund().declineReason).toBeNull();
    });

    it("refuses a second decision on a Declined request with 409", () => {
      decideRefundRequest(refundId, base.instructor.id, {
        intent: "decline",
        reason: VALID_REASON,
      });

      const status = thrownStatus(() =>
        decideRefundRequest(refundId, base.instructor.id, { intent: "approve" })
      );

      expect(status).toBe(409);
      expect(getRefund().status).toBe(schema.RefundStatus.Declined);
      expect(isEnrolled()).toBe(true);
    });
  });
});
