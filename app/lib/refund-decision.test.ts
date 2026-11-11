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

import {
  decideRefundRequest,
  getDeclinedRefundRequests,
} from "./refund-decision";

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

      const result = decideRefundRequest(refundId, other.id, {
        intent: "approve",
      });

      expect(result).toMatchObject({ ok: false, status: 403 });
      expect(getRefund().status).toBe(schema.RefundStatus.Requested);
      expect(isEnrolled()).toBe(true);
    });

    it("refuses the learner", () => {
      const result = decideRefundRequest(refundId, base.user.id, {
        intent: "approve",
      });

      expect(result).toMatchObject({ ok: false, status: 403 });
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
      const result = decideRefundRequest(9999, base.instructor.id, {
        intent: "approve",
      });

      expect(result).toMatchObject({ ok: false, status: 404 });
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
    ])("refuses a reason that is %s with 400", (_label, reason) => {
      const result = decideRefundRequest(refundId, base.instructor.id, {
        intent: "decline",
        reason,
      });

      expect(result).toMatchObject({ ok: false, status: 400 });
      if (!result.ok) expect(result.errors?.reason).toBeTruthy();
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

  it("refuses an unknown intent with 400", () => {
    const result = decideRefundRequest(refundId, base.instructor.id, {
      intent: "refund-half",
    });

    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(getRefund().status).toBe(schema.RefundStatus.Requested);
  });

  describe("email to the learner", () => {
    it("tells the learner their Refund Request was Approved and for how much", () => {
      const result = decideRefundRequest(refundId, base.instructor.id, {
        intent: "approve",
      });

      if (!result.ok) throw new Error(result.error);
      expect(result.email.to).toBe("test@example.com");
      expect(result.email.subject).toContain("Test Course");
      expect(result.email.body).toContain("approved");
      expect(result.email.body).toContain("$100");
    });

    it("tells the learner their Refund Request was Declined, with the reason", () => {
      const result = decideRefundRequest(refundId, base.instructor.id, {
        intent: "decline",
        reason: VALID_REASON,
      });

      if (!result.ok) throw new Error(result.error);
      expect(result.email.to).toBe("test@example.com");
      expect(result.email.body).toContain("declined");
      expect(result.email.body).toContain(VALID_REASON);
    });
  });

  describe("getDeclinedRefundRequests", () => {
    it("lists the learner's Declined Refund Requests with the decline reason", () => {
      decideRefundRequest(refundId, base.instructor.id, {
        intent: "decline",
        reason: VALID_REASON,
      });

      expect(getDeclinedRefundRequests(base.user.id)).toEqual([
        expect.objectContaining({
          id: refundId,
          courseTitle: "Test Course",
          courseSlug: "test-course",
          declineReason: VALID_REASON,
        }),
      ]);
    });

    it("leaves out Requested and Approved Refund Requests, and other learners'", () => {
      expect(getDeclinedRefundRequests(base.user.id)).toEqual([]);

      decideRefundRequest(refundId, base.instructor.id, { intent: "approve" });

      expect(getDeclinedRefundRequests(base.user.id)).toEqual([]);
      expect(getDeclinedRefundRequests(base.instructor.id)).toEqual([]);
    });
  });

  describe("decisions are final", () => {
    it("refuses a second decision on an Approved request with 409", () => {
      decideRefundRequest(refundId, base.instructor.id, { intent: "approve" });

      const result = decideRefundRequest(refundId, base.instructor.id, {
        intent: "decline",
        reason: VALID_REASON,
      });

      expect(result).toMatchObject({ ok: false, status: 409 });
      expect(getRefund().status).toBe(schema.RefundStatus.Approved);
      expect(getRefund().declineReason).toBeNull();
    });

    it("refuses a second decision on a Declined request with 409", () => {
      decideRefundRequest(refundId, base.instructor.id, {
        intent: "decline",
        reason: VALID_REASON,
      });

      const result = decideRefundRequest(refundId, base.instructor.id, {
        intent: "approve",
      });

      expect(result).toMatchObject({ ok: false, status: 409 });
      expect(getRefund().status).toBe(schema.RefundStatus.Declined);
      expect(isEnrolled()).toBe(true);
    });
  });
});
