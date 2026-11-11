import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "~/db";
import {
  courses,
  enrollments,
  purchases,
  refunds,
  users,
  RefundStatus,
  UserRole,
} from "~/db/schema";
import { formatPrice } from "./utils";
import { getRefundEligibility } from "./refund-eligibility";

// Same rules as the learner's reason on the Refund Request.
const declineReasonSchema = z
  .string({ required_error: "Tell the learner why you are declining." })
  .trim()
  .min(10, "Tell the learner a little more about why you are declining.")
  .max(1000, "Please keep the reason under 1000 characters.");

const refundDecisionSchema = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("approve") }),
  z.object({ intent: z.literal("decline"), reason: declineReasonSchema }),
]);

export type RefundDecision = z.infer<typeof refundDecisionSchema>;

export type RefundDecisionEmail = {
  to: string;
  subject: string;
  body: string;
};

export type RefundDecisionSuccess = {
  ok: true;
  status: RefundStatus.Approved | RefundStatus.Declined;
  /** The email to send the learner about the outcome. */
  email: RefundDecisionEmail;
};

export type RefundDecisionFailure = {
  ok: false;
  status: 400 | 403 | 404 | 409;
  error: string;
  /** Field errors, first message per field, when status is 400. */
  errors?: Record<string, string>;
};

export type DecideRefundResult = RefundDecisionSuccess | RefundDecisionFailure;

function fail(
  status: RefundDecisionFailure["status"],
  error: string
): RefundDecisionFailure {
  return { ok: false, status, error };
}

function buildApprovedEmail(input: {
  learnerName: string;
  learnerEmail: string;
  courseTitle: string;
  amount: number;
}): RefundDecisionEmail {
  return {
    to: input.learnerEmail,
    subject: `Refund approved — ${input.courseTitle}`,
    body: [
      `Hi ${input.learnerName},`,
      "",
      `Your Refund Request for "${input.courseTitle}" has been approved.`,
      `We are sending you a Refund of ${formatPrice(input.amount)}.`,
      "You no longer have access to the course.",
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}

function buildDeclinedEmail(input: {
  learnerName: string;
  learnerEmail: string;
  courseTitle: string;
  reason: string;
}): RefundDecisionEmail {
  return {
    to: input.learnerEmail,
    subject: `Refund declined — ${input.courseTitle}`,
    body: [
      `Hi ${input.learnerName},`,
      "",
      `Your Refund Request for "${input.courseTitle}" has been declined, so no Refund will be paid. The reason given:`,
      "",
      input.reason,
      "",
      "You still have access to the course.",
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}

/**
 * Approves or Declines one Refund Request on behalf of `deciderUserId`.
 *
 * `input` is the raw form: `intent` is `approve` or `decline`, and a decline
 * needs a `reason` (trimmed, 10–1000 characters).
 *
 * Only the Instructor who owns the Course, or any Admin, may decide, and only
 * while the Refund Request is Requested: decisions are final (ADR 0002).
 * Refund Eligibility is advisory (ADR 0001), so an ineligible request can
 * still be Approved. Approving records the Refundable Amount and removes the
 * learner's enrollment.
 *
 * Never throws for an expected refusal; returns `ok: false` with an HTTP
 * status (404, 403, 409, 400 — checked in that order) instead.
 */
export function decideRefundRequest(
  refundId: number,
  deciderUserId: number,
  input: Record<string, unknown>
): DecideRefundResult {
  const row = db
    .select({
      refund: refunds,
      purchase: purchases,
      course: courses,
      learner: users,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .where(eq(refunds.id, refundId))
    .get();

  if (!row) return fail(404, "Refund Request not found.");

  const { refund, purchase, course, learner } = row;

  const decider = db
    .select()
    .from(users)
    .where(eq(users.id, deciderUserId))
    .get();

  const mayDecide =
    decider !== undefined &&
    (decider.role === UserRole.Admin || course.instructorId === decider.id);

  if (!mayDecide) {
    return fail(
      403,
      "Only this course's instructor or an admin can decide this Refund Request."
    );
  }

  if (refund.status !== RefundStatus.Requested) {
    return fail(409, "This Refund Request has already been decided.");
  }

  const parsed = refundDecisionSchema.safeParse(input);

  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const [field, messages] of Object.entries(
      parsed.error.flatten().fieldErrors
    )) {
      if (messages?.[0]) errors[field] = messages[0];
    }
    return { ...fail(400, "Invalid decision."), errors };
  }

  const decision = parsed.data;
  const resolvedAt = new Date().toISOString();
  // Guarding on Requested in the update too means two deciders racing each
  // other cannot both win.
  const stillRequested = and(
    eq(refunds.id, refundId),
    eq(refunds.status, RefundStatus.Requested)
  );

  if (decision.intent === "decline") {
    const updated = db
      .update(refunds)
      .set({
        status: RefundStatus.Declined,
        declineReason: decision.reason,
        resolvedAt,
        resolvedByUserId: deciderUserId,
      })
      .where(stillRequested)
      .run();

    if (updated.changes === 0) {
      return fail(409, "This Refund Request has already been decided.");
    }

    return {
      ok: true,
      status: RefundStatus.Declined,
      email: buildDeclinedEmail({
        learnerName: learner.name,
        learnerEmail: learner.email,
        courseTitle: course.title,
        reason: decision.reason,
      }),
    };
  }

  // The Refund Window is judged on the day the Refund Request was made;
  // watching and completion as they stand now (GLOSSARY: Refund Eligibility).
  const eligibility = getRefundEligibility(purchase.id, {
    windowJudgedOn: new Date(refund.requestedAt),
  });

  if (!eligibility) return fail(404, "Purchase not found.");

  const approved = db.transaction((tx) => {
    const updated = tx
      .update(refunds)
      .set({
        status: RefundStatus.Approved,
        amountRefunded: eligibility.refundableAmount,
        resolvedAt,
        resolvedByUserId: deciderUserId,
      })
      .where(stillRequested)
      .run();

    if (updated.changes === 0) return false;

    tx.delete(enrollments)
      .where(
        and(
          eq(enrollments.userId, purchase.userId),
          eq(enrollments.courseId, purchase.courseId)
        )
      )
      .run();

    return true;
  });

  if (!approved) {
    return fail(409, "This Refund Request has already been decided.");
  }

  return {
    ok: true,
    status: RefundStatus.Approved,
    email: buildApprovedEmail({
      learnerName: learner.name,
      learnerEmail: learner.email,
      courseTitle: course.title,
      amount: eligibility.refundableAmount,
    }),
  };
}

/**
 * The learner's Declined Refund Requests, newest decision first, with the
 * reason the Instructor or Admin gave.
 */
export function getDeclinedRefundRequests(learnerId: number) {
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
