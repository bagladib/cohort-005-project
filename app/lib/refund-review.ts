import { and, asc, eq } from "drizzle-orm";
import { db } from "~/db";
import { courses, purchases, refunds, RefundStatus, users } from "~/db/schema";
import {
  getRefundEligibility,
  type RefundEligibility,
} from "./refund-eligibility";

/** A Refund Request on the same Purchase that was turned down before. */
export type DeclinedRefundRequest = {
  id: number;
  /** The learner's reason for that request. */
  reason: string;
  /** The reason the Instructor or Admin gave the learner for declining it. */
  declineReason: string | null;
  requestedAt: string;
  resolvedAt: string | null;
};

/** The Instructor or Admin who decides Refund Requests. */
export type RefundDecider = { userId: number; isAdmin: boolean };

export type RequestedRefundRequest = {
  id: number;
  purchaseId: number;
  learnerName: string;
  courseId: number;
  courseTitle: string;
  reason: string;
  requestedAt: string;
  /**
   * Advisory only (ADR 0001). The Refund Window is judged on the day the
   * request was made; watching and completion are counted up to now.
   */
  eligibility: RefundEligibility;
  /** Earlier Declined Refund Requests on the same Purchase, oldest first. */
  earlierDeclined: DeclinedRefundRequest[];
};

/**
 * The Requested Refund Requests a decider may decide: an Admin sees every
 * Course's, an Instructor only their own Courses'. Oldest first.
 */
export function getRequestedRefundRequests(
  decider: RefundDecider
): RequestedRefundRequest[] {
  const conditions = [eq(refunds.status, RefundStatus.Requested)];
  if (!decider.isAdmin) {
    conditions.push(eq(courses.instructorId, decider.userId));
  }

  const rows = db
    .select({
      id: refunds.id,
      purchaseId: refunds.purchaseId,
      learnerName: users.name,
      courseId: courses.id,
      courseTitle: courses.title,
      reason: refunds.reason,
      requestedAt: refunds.requestedAt,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(and(...conditions))
    .orderBy(asc(refunds.requestedAt), asc(refunds.id))
    .all();

  return rows.flatMap((row) => {
    const eligibility = getRefundEligibility(row.purchaseId, {
      windowJudgedOn: new Date(row.requestedAt),
    });
    // The inner join on purchases means the Purchase exists; this only
    // narrows the type.
    if (!eligibility) return [];

    return [
      {
        ...row,
        eligibility,
        earlierDeclined: getEarlierDeclinedRefundRequests(row.purchaseId),
      },
    ];
  });
}

// A Purchase has at most one Requested Refund Request at a time, and a new one
// can only be made after a decision, so every Declined one came before it.
function getEarlierDeclinedRefundRequests(
  purchaseId: number
): DeclinedRefundRequest[] {
  return db
    .select({
      id: refunds.id,
      reason: refunds.reason,
      declineReason: refunds.declineReason,
      requestedAt: refunds.requestedAt,
      resolvedAt: refunds.resolvedAt,
    })
    .from(refunds)
    .where(
      and(
        eq(refunds.purchaseId, purchaseId),
        eq(refunds.status, RefundStatus.Declined)
      )
    )
    .orderBy(asc(refunds.requestedAt), asc(refunds.id))
    .all();
}
