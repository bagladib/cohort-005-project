import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "~/db";
import { courses, purchases, refunds, RefundStatus } from "~/db/schema";

// Refund Requests as the learner who made them sees them.

/**
 * The learner's Declined Refund Requests, newest decision first, with the
 * reason the Instructor or Admin gave.
 */
export function getLearnerDeclinedRefundRequests(learnerId: number) {
  return db
    .select({
      id: refunds.id,
      courseTitle: courses.title,
      courseSlug: courses.slug,
      reason: refunds.reason,
      declineReason: refunds.declineReason,
      requestedAt: refunds.requestedAt,
      resolvedAt: refunds.resolvedAt,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(
      and(
        eq(purchases.userId, learnerId),
        eq(refunds.status, RefundStatus.Declined)
      )
    )
    .orderBy(desc(refunds.resolvedAt))
    .all();
}

/**
 * The Refund Request that stops the learner making a new one on this
 * Purchase: one still Requested, or one Approved (Approved is final, so the
 * Purchase has already been refunded). A Declined one does not block.
 *
 * This is not part of Refund Eligibility: it is about the Refund Requests
 * already made, not about the Purchase.
 */
export function getBlockingRefundRequest(purchaseId: number) {
  return db
    .select({ id: refunds.id, status: refunds.status })
    .from(refunds)
    .where(
      and(
        eq(refunds.purchaseId, purchaseId),
        inArray(refunds.status, [
          RefundStatus.Requested,
          RefundStatus.Approved,
        ])
      )
    )
    .get();
}
