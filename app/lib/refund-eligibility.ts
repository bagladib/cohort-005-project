import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  coupons,
  courses,
  lessonProgress,
  lessons,
  modules,
  purchases,
  videoWatchEvents,
  LessonProgressStatus,
} from "~/db/schema";
import { getDiscountForCountry } from "./ppp";

export const REFUND_WINDOW_DAYS = 14;
export const REFUND_WATCH_LIMIT_SECONDS = 2 * 60 * 60;
export const REFUND_COMPLETION_LIMIT = 0.5;

export type RefundFacts = {
  purchasedAt: string;
  country: string | null;
  amountPaid: number;
  listPrice: number;
  watchedSeconds: number;
  completedLessons: number;
  totalLessons: number;
  claimedTeamSeat: boolean;
};

export type RefundEligibility = {
  eligible: boolean;
  rules: {
    refundWindow: { passed: boolean };
    watchTime: { passed: boolean };
    completion: { passed: boolean };
    teamSeat: { passed: boolean };
  };
  refundableAmount: number;
  lastDayInWindow: string;
};

// The window is counted in whole calendar days, not hours: a purchase at
// 23:00 still gets the whole of its fourteenth day.
function calendarDay(when: Date): string {
  const month = String(when.getMonth() + 1).padStart(2, "0");
  const day = String(when.getDate()).padStart(2, "0");
  return `${when.getFullYear()}-${month}-${day}`;
}

export function judgeRefundEligibility(
  facts: RefundFacts,
  windowJudgedOn: Date
): RefundEligibility {
  const windowEnd = new Date(facts.purchasedAt);
  windowEnd.setDate(windowEnd.getDate() + REFUND_WINDOW_DAYS);
  const lastDayInWindow = calendarDay(windowEnd);
  const judgedDay = calendarDay(windowJudgedOn);

  const purchasedDay = calendarDay(new Date(facts.purchasedAt));
  const refundWindow = {
    passed: judgedDay >= purchasedDay && judgedDay <= lastDayInWindow,
  };

  const watchTime = {
    passed: facts.watchedSeconds < REFUND_WATCH_LIMIT_SECONDS,
  };

  const completion = {
    passed:
      facts.totalLessons === 0 ||
      facts.completedLessons / facts.totalLessons < REFUND_COMPLETION_LIMIT,
  };

  const teamSeat = { passed: !facts.claimedTeamSeat };

  const rules = { refundWindow, watchTime, completion, teamSeat };

  return {
    eligible: Object.values(rules).every((rule) => rule.passed),
    rules,
    // A purchasing-power purchase is refunded at the price that was paid, not
    // at the list price of the course.
    refundableAmount:
      getDiscountForCountry(facts.country) > 0
        ? facts.amountPaid
        : facts.listPrice,
    lastDayInWindow,
  };
}

function getCourseLessonIds(courseId: number): number[] {
  return db
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .all()
    .map((row) => row.id);
}

function getCompletedLessonCount(userId: number, lessonIds: number[]) {
  if (lessonIds.length === 0) return 0;

  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(lessonProgress)
    .where(
      and(
        eq(lessonProgress.userId, userId),
        eq(lessonProgress.status, LessonProgressStatus.Completed),
        inArray(lessonProgress.lessonId, lessonIds)
      )
    )
    .get();

  return result?.count ?? 0;
}

// Watch time is the furthest point reached in each lesson, summed.
function getSecondsWatched(userId: number, lessonIds: number[]) {
  if (lessonIds.length === 0) return 0;

  return db
    .select({
      furthest: sql<number>`max(${videoWatchEvents.positionSeconds})`,
    })
    .from(videoWatchEvents)
    .where(
      and(
        eq(videoWatchEvents.userId, userId),
        inArray(videoWatchEvents.lessonId, lessonIds)
      )
    )
    .groupBy(videoWatchEvents.lessonId)
    .all()
    .reduce((total, row) => total + row.furthest, 0);
}

function hasClaimedTeamSeat(purchaseId: number) {
  const claimed = db
    .select({ id: coupons.id })
    .from(coupons)
    .where(
      and(eq(coupons.purchaseId, purchaseId), isNotNull(coupons.redeemedAt))
    )
    .get();

  return claimed !== undefined;
}

/**
 * Refund Eligibility for a Purchase, read from the database. Watching and
 * completion are counted as they stand now; the Refund Window is judged on
 * `windowJudgedOn` (the day the Refund Request was made), defaulting to now.
 * Returns null if the Purchase does not exist.
 */
export function getRefundEligibility(
  purchaseId: number,
  options: { windowJudgedOn?: Date } = {}
): RefundEligibility | null {
  const row = db
    .select({ purchase: purchases, listPrice: courses.price })
    .from(purchases)
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(purchases.id, purchaseId))
    .get();

  if (!row) return null;

  const { purchase, listPrice } = row;
  const lessonIds = getCourseLessonIds(purchase.courseId);

  return judgeRefundEligibility(
    {
      purchasedAt: purchase.createdAt,
      country: purchase.country,
      amountPaid: purchase.amountPaid,
      listPrice,
      watchedSeconds: getSecondsWatched(purchase.userId, lessonIds),
      completedLessons: getCompletedLessonCount(purchase.userId, lessonIds),
      totalLessons: lessonIds.length,
      claimedTeamSeat: hasClaimedTeamSeat(purchase.id),
    },
    options.windowJudgedOn ?? new Date()
  );
}
