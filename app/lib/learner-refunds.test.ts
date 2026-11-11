import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";

let testDb: ReturnType<typeof createTestDb>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

import {
  getBlockingRefundRequest,
  getLearnerDeclinedRefundRequests,
} from "./learner-refunds";

const DECLINE_REASON = "The course covers what you asked for in lesson one.";

let base: ReturnType<typeof seedBaseData>;
let purchaseId: number;

function refundRequest(
  overrides: Partial<typeof schema.refunds.$inferInsert> = {}
) {
  return testDb
    .insert(schema.refunds)
    .values({ purchaseId, reason: "Not what I expected.", ...overrides })
    .returning()
    .get();
}

beforeEach(() => {
  testDb = createTestDb();
  base = seedBaseData(testDb);
  purchaseId = testDb
    .insert(schema.purchases)
    .values({
      userId: base.user.id,
      courseId: base.course.id,
      amountPaid: 10000,
      country: "US",
    })
    .returning()
    .get().id;
});

describe("getLearnerDeclinedRefundRequests", () => {
  it("lists the learner's Declined Refund Requests with the decline reason", () => {
    const declined = refundRequest({
      status: schema.RefundStatus.Declined,
      declineReason: DECLINE_REASON,
      resolvedAt: new Date().toISOString(),
    });

    expect(getLearnerDeclinedRefundRequests(base.user.id)).toEqual([
      expect.objectContaining({
        id: declined.id,
        courseTitle: "Test Course",
        courseSlug: "test-course",
        declineReason: DECLINE_REASON,
      }),
    ]);
  });

  it("leaves out Requested and Approved Refund Requests, and other learners'", () => {
    refundRequest();
    refundRequest({ status: schema.RefundStatus.Approved });

    expect(getLearnerDeclinedRefundRequests(base.user.id)).toEqual([]);

    refundRequest({ status: schema.RefundStatus.Declined });

    expect(getLearnerDeclinedRefundRequests(base.instructor.id)).toEqual([]);
  });
});

describe("getBlockingRefundRequest", () => {
  it("lets a learner make a Refund Request on a Purchase with none", () => {
    expect(getBlockingRefundRequest(purchaseId)).toBeUndefined();
  });

  it("blocks a new Refund Request while one is Requested", () => {
    const requested = refundRequest();

    expect(getBlockingRefundRequest(purchaseId)).toEqual({
      id: requested.id,
      status: schema.RefundStatus.Requested,
    });
  });

  it("blocks a new Refund Request once one is Approved, because Approved is final", () => {
    refundRequest({ status: schema.RefundStatus.Declined });
    const approved = refundRequest({ status: schema.RefundStatus.Approved });

    expect(getBlockingRefundRequest(purchaseId)).toEqual({
      id: approved.id,
      status: schema.RefundStatus.Approved,
    });
  });

  it("lets a learner make a new Refund Request after a Declined one", () => {
    refundRequest({ status: schema.RefundStatus.Declined });

    expect(getBlockingRefundRequest(purchaseId)).toBeUndefined();
  });
});
