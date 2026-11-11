import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import { eq } from "drizzle-orm";
import * as schema from "~/db/schema";

let testDb: ReturnType<typeof createTestDb>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

import { getRequestedRefundRequests } from "./refund-review";

let base: ReturnType<typeof seedBaseData>;

beforeEach(() => {
  testDb = createTestDb();
  base = seedBaseData(testDb);
});

function purchase(
  overrides: Partial<typeof schema.purchases.$inferInsert> = {}
) {
  return testDb
    .insert(schema.purchases)
    .values({
      userId: base.user.id,
      courseId: base.course.id,
      amountPaid: 10000,
      country: "US",
      createdAt: new Date(2026, 0, 1, 10).toISOString(),
      ...overrides,
    })
    .returning()
    .get();
}

function refundRequest(
  purchaseId: number,
  overrides: Partial<typeof schema.refunds.$inferInsert> = {}
) {
  return testDb
    .insert(schema.refunds)
    .values({
      purchaseId,
      reason: "Not what I expected",
      requestedAt: new Date(2026, 0, 5, 12).toISOString(),
      ...overrides,
    })
    .returning()
    .get();
}

const asInstructor = () => ({ userId: base.instructor.id, isAdmin: false });

describe("getRequestedRefundRequests", () => {
  it("shows an Instructor the Requested Refund Requests on their own Course", () => {
    const bought = purchase();
    const request = refundRequest(bought.id);

    const rows = getRequestedRefundRequests(asInstructor());

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: request.id,
      purchaseId: bought.id,
      learnerName: "Test User",
      courseTitle: "Test Course",
      reason: "Not what I expected",
      requestedAt: request.requestedAt,
    });
  });

  it("hides Refund Requests on another Instructor's Course from an Instructor", () => {
    const otherCourse = anotherInstructorsCourse();
    refundRequest(purchase({ courseId: otherCourse.id }).id);

    expect(getRequestedRefundRequests(asInstructor())).toEqual([]);
  });

  it("shows an Admin the Requested Refund Requests on every Course", () => {
    const admin = testDb
      .insert(schema.users)
      .values({ name: "Ada Admin", email: "admin@example.com", role: schema.UserRole.Admin })
      .returning()
      .get();
    const otherCourse = anotherInstructorsCourse();
    refundRequest(purchase().id);
    refundRequest(purchase({ courseId: otherCourse.id }).id);

    const rows = getRequestedRefundRequests({ userId: admin.id, isAdmin: true });

    expect(rows.map((row) => row.courseTitle)).toEqual(["Test Course", "Other Course"]);
  });

  it("leaves out Refund Requests that are already Approved or Declined", () => {
    const bought = purchase();
    refundRequest(bought.id, { status: schema.RefundStatus.Declined });
    refundRequest(purchase().id, { status: schema.RefundStatus.Approved });

    expect(getRequestedRefundRequests(asInstructor())).toEqual([]);
  });

  describe("Refund Eligibility", () => {
    it("judges the Refund Window on the day the Refund Request was made", () => {
      // Bought 1 Jan, asked on 5 Jan: inside the window, however late the
      // Instructor gets round to it.
      refundRequest(purchase().id);

      const [row] = getRequestedRefundRequests(asInstructor());

      expect(row.eligibility.rules.refundWindow.passed).toBe(true);
      expect(row.eligibility.eligible).toBe(true);
    });

    it("marks a request made after the Refund Window ineligible but still lists it", () => {
      refundRequest(purchase().id, {
        requestedAt: new Date(2026, 0, 20, 12).toISOString(),
      });

      const rows = getRequestedRefundRequests(asInstructor());

      expect(rows).toHaveLength(1);
      expect(rows[0].eligibility.rules.refundWindow.passed).toBe(false);
      expect(rows[0].eligibility.eligible).toBe(false);
    });

    it("counts watching up to now, not up to the request", () => {
      const lessonId = lessonOnBaseCourse();
      refundRequest(purchase().id);
      testDb
        .insert(schema.videoWatchEvents)
        .values({
          userId: base.user.id,
          lessonId,
          eventType: "progress",
          positionSeconds: 3 * 60 * 60,
          createdAt: new Date().toISOString(),
        })
        .run();

      const [row] = getRequestedRefundRequests(asInstructor());

      expect(row.eligibility.rules.watchTime.passed).toBe(false);
      expect(row.eligibility.rules.refundWindow.passed).toBe(true);
      expect(row.eligibility.eligible).toBe(false);
    });

    it("carries the Refundable Amount", () => {
      testDb
        .update(schema.courses)
        .set({ price: 12000 })
        .where(eq(schema.courses.id, base.course.id))
        .run();
      refundRequest(purchase({ amountPaid: 12000 }).id);

      const [row] = getRequestedRefundRequests(asInstructor());

      expect(row.eligibility.refundableAmount).toBe(12000);
    });
  });

  describe("earlier Declined Refund Requests", () => {
    it("lists earlier Declined requests on the same Purchase, oldest first", () => {
      const bought = purchase();
      const first = refundRequest(bought.id, {
        status: schema.RefundStatus.Declined,
        reason: "Too hard",
        requestedAt: new Date(2026, 0, 2, 9).toISOString(),
        resolvedAt: new Date(2026, 0, 3, 9).toISOString(),
      });
      const second = refundRequest(bought.id, {
        status: schema.RefundStatus.Declined,
        reason: "Still too hard",
        requestedAt: new Date(2026, 0, 3, 12).toISOString(),
        resolvedAt: new Date(2026, 0, 4, 9).toISOString(),
      });
      refundRequest(bought.id);

      const [row] = getRequestedRefundRequests(asInstructor());

      expect(row.earlierDeclined).toEqual([
        {
          id: first.id,
          reason: "Too hard",
          requestedAt: first.requestedAt,
          resolvedAt: first.resolvedAt,
        },
        {
          id: second.id,
          reason: "Still too hard",
          requestedAt: second.requestedAt,
          resolvedAt: second.resolvedAt,
        },
      ]);
    });

    it("does not list Declined requests from another Purchase", () => {
      refundRequest(purchase().id, { status: schema.RefundStatus.Declined });
      refundRequest(purchase().id);

      const [row] = getRequestedRefundRequests(asInstructor());

      expect(row.earlierDeclined).toEqual([]);
    });
  });
});

function lessonOnBaseCourse() {
  const mod = testDb
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Module", position: 1 })
    .returning()
    .get();
  return testDb
    .insert(schema.lessons)
    .values({ moduleId: mod.id, title: "Lesson", position: 1 })
    .returning()
    .get().id;
}

function anotherInstructorsCourse() {
  const other = testDb
    .insert(schema.users)
    .values({ name: "Other Instructor", email: "other@example.com", role: schema.UserRole.Instructor })
    .returning()
    .get();
  return testDb
    .insert(schema.courses)
    .values({
      title: "Other Course",
      slug: "other-course",
      description: "Another course",
      salesCopy: "Sales copy",
      instructorId: other.id,
      categoryId: base.category.id,
      status: schema.CourseStatus.Published,
    })
    .returning()
    .get();
}
