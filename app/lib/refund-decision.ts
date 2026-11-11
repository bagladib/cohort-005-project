import { and, eq } from "drizzle-orm";
import { data } from "react-router";
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

/** The decision form was invalid; nothing was decided. */
export type RefundDecisionInvalid = {
  ok: false;
  /** Field errors, first message per field. */
  errors: Record<string, string>;
};

export type DecideRefundResult = RefundDecisionSuccess | RefundDecisionInvalid;

// Decisions are final (ADR 0002), so a second one is a conflict.
function alreadyDecided() {
  return data("This Refund Request has already been decided.", {
    status: 409,
  });
}

function buildApprovedEmail(input: {
  learnerName: string;
  learnerEmail: string;
  courseTitle: string;
  amount: number;
}): RefundDecisionEmail {
  return {
    to: input.learnerEmail,
    subject: `Refund Request approved — ${input.courseTitle}`,
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
    subject: `Refund Request declined — ${input.courseTitle}`,
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
 * Throws a 404, 403 or 409 response (checked in that order) when the
 * decision cannot be made. An invalid form is returned as `ok: false` with
 * field errors, for the screen to show next to the fields.
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

  if (!row) throw data("Refund Request not found.", { status: 404 });

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
    throw data(
      "Only this course's instructor or an admin can decide this Refund Request.",
      { status: 403 }
    );
  }

  if (refund.status !== RefundStatus.Requested) throw alreadyDecided();

  const parsed = refundDecisionSchema.safeParse(input);

  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const [field, messages] of Object.entries(
      parsed.error.flatten().fieldErrors
    )) {
      if (messages?.[0]) errors[field] = messages[0];
    }
    return { ok: false, errors };
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

    if (updated.changes === 0) throw alreadyDecided();

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

  if (!eligibility) throw data("Purchase not found.", { status: 404 });

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
    throw alreadyDecided();
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
